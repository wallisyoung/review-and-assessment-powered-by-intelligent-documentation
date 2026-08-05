import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { Amplify } from "aws-amplify";
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchUserAttributes,
  fetchAuthSession,
} from "aws-amplify/auth";

// 環境変数から設定を取得
// CDKのbuildViteAppで設定される環境変数名に合わせる
const region = import.meta.env.VITE_APP_REGION || "ap-northeast-1";
const userPoolId = import.meta.env.VITE_APP_USER_POOL_ID;
const userPoolWebClientId = import.meta.env.VITE_APP_USER_POOL_CLIENT_ID;

// Amplify設定 - v6形式に修正
Amplify.configure({
  Auth: {
    Cognito: {
      region,
      userPoolId,
      userPoolClientId: userPoolWebClientId,
    },
  },
});

/**
 * ID トークン (JWT) の payload をデコードして返す。
 * 署名検証はバックエンドで行うため、ここでは UI 表示用途のデコードのみ行う。
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * ID トークンから custom:rapid_role を読み取り isAdmin を判定する。
 * バックエンド (api/core/middleware/auth.ts) と同一の claim 参照ロジック。
 * claim が無い/読めない場合は安全側に倒して false とする。
 */
function extractIsAdmin(idToken: string | null): boolean {
  if (!idToken) return false;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return false;
  const rapidRole =
    (payload["custom:rapid_role"] as string | undefined) ??
    (payload["custom_rapid_role"] as string | undefined);
  return typeof rapidRole === "string" && rapidRole.toLowerCase() === "admin";
}

interface AuthContextType {
  isAuthenticated: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  user: any | null;
  signIn: (username: string, password: string) => Promise<any>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
  checkAuthState: () => Promise<void>; // 追加
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<any | null>(null);

  useEffect(() => {
    checkAuthState();
  }, []);

  async function checkAuthState() {
    try {
      const currentUser = await getCurrentUser();
      const attributes = await fetchUserAttributes();
      setUser({ ...currentUser, ...attributes });
      setIsAuthenticated(true);

      // ID トークンから custom:rapid_role を読み取り isAdmin を設定。
      // バックエンド (auth.ts) と同じ claim を使い、真実の情報源を一つにする。
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken?.toString() ?? null;
      setIsAdmin(extractIsAdmin(idToken));
    } catch (error) {
      setUser(null);
      setIsAuthenticated(false);
      setIsAdmin(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSignIn(username: string, password: string) {
    try {
      const user = await signIn({ username, password });
      await checkAuthState();
      return user;
    } catch (error) {
      throw error;
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
      setUser(null);
      setIsAuthenticated(false);
      setIsAdmin(false);
    } catch (error) {
      console.error("Error signing out:", error);
    }
  }

  async function getIdToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() || null;
    } catch (error) {
      console.error("Error getting ID token:", error);
      return null;
    }
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isAdmin,
        isLoading,
        user,
        signIn: handleSignIn,
        signOut: handleSignOut,
        getIdToken,
        checkAuthState, // 追加
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
