import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface AdminRouteProps {
  children: React.ReactNode;
}

/**
 * 管理者（admin / opsEngineer）専用ページのルートガード
 * ロード中は判定を待ち、管理者以外は /checklist へリダイレクトする
 */
export default function AdminRoute({ children }: AdminRouteProps) {
  const { isAdmin, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-t-2 border-indigo-500" />
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/checklist" replace />;
  }

  return <>{children}</>;
}
