import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SWRConfig } from "swr";
import Layout from "./components/Layout";
import {
  CheckListPage,
  CheckListSetDetailPage,
  CreateChecklistPage,
} from "./features/checklist";
import {
  ReviewListPage,
  CreateReviewPage,
  ReviewDetailPage,
} from "./features/review";
import {
  ToolConfigurationListPage,
  CreateToolConfigurationPage,
  ToolConfigurationDetailPage,
} from "./features/tool-configuration";
import { ExamplesPage } from "./features/examples";
import NotFoundPage from "./pages/NotFoundPage";
import ProtectedRoute from "./components/ProtectedRoute";
import OpsEngineerRoute from "./components/OpsEngineerRoute";
import { ToastProvider } from "./contexts/ToastContext";
import { AuthProvider } from "./contexts/AuthContext";
import { LanguageProvider } from "./contexts/LanguageContext";
import { ChecklistPromptTemplatesPage } from "./features/prompt-template/pages/ChecklistPromptTemplatesPage";
import "./App.css";

function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <SWRConfig
          value={{
            errorRetryCount: 3,
            revalidateOnFocus: false,
            revalidateIfStale: false,
            shouldRetryOnError: true,
          }}>
          <ToastProvider>
            <BrowserRouter
              basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}
              future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
              }}>
              <Routes>
                <Route
                  path="/"
                  element={<Navigate to="/checklist" replace />}
                />

                <Route
                  path="/"
                  element={
                    <ProtectedRoute>
                      <Layout />
                    </ProtectedRoute>
                  }>
                  <Route path="checklist" element={<CheckListPage />} />
                  <Route
                    path="checklist/new"
                    element={<CreateChecklistPage />}
                  />
                  <Route
                    path="checklist/:id"
                    element={<CheckListSetDetailPage />}
                  />

                  <Route path="review" element={<ReviewListPage />} />
                  <Route path="review/create" element={<CreateReviewPage />} />
                  <Route path="review/:id" element={<ReviewDetailPage />} />

                  <Route
                    path="examples"
                    element={
                      <OpsEngineerRoute>
                        <ExamplesPage />
                      </OpsEngineerRoute>
                    }
                  />

                  <Route
                    path="tool-configurations"
                    element={
                      <OpsEngineerRoute>
                        <ToolConfigurationListPage />
                      </OpsEngineerRoute>
                    }
                  />
                  <Route
                    path="tool-configurations/new"
                    element={
                      <OpsEngineerRoute>
                        <CreateToolConfigurationPage />
                      </OpsEngineerRoute>
                    }
                  />
                  <Route
                    path="tool-configurations/:id"
                    element={
                      <OpsEngineerRoute>
                        <ToolConfigurationDetailPage />
                      </OpsEngineerRoute>
                    }
                  />

                  <Route
                    path="prompt-templates/checklist"
                    element={
                      <OpsEngineerRoute>
                        <ChecklistPromptTemplatesPage />
                      </OpsEngineerRoute>
                    }
                  />

                  <Route path="documents" element={<ReviewListPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </SWRConfig>
      </LanguageProvider>
    </AuthProvider>
  );
}

export default App;
