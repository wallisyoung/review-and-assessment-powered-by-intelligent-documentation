import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

interface OpsEngineerRouteProps {
  children: React.ReactNode;
}

/**
 * opsEngineer 専用ページのルートガード
 * ロード中は判定を待ち、opsEngineer 以外（admin 含む）は /checklist へリダイレクトする
 *
 * 2 層権限モデル: opsEngineer は admin 権限をすべて含む包含関係。
 * 本ガードで守るページ（サンプル / ツール設定 / プロンプト設定）は
 * opsEngineer 専層であり、admin 層（isAdmin）ではない点に注意。
 */
export default function OpsEngineerRoute({ children }: OpsEngineerRouteProps) {
  const { isOpsEngineer, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-t-2 border-indigo-500" />
      </div>
    );
  }

  if (!isOpsEngineer) {
    return <Navigate to="/checklist" replace />;
  }

  return <>{children}</>;
}
