import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Sync } from "@/pages/Sync";
import { Products } from "@/pages/Products";
import { Vendors } from "@/pages/Vendors";
import { Orders } from "@/pages/Orders";
import { Secrets } from "@/pages/Secrets";
import { Settings } from "@/pages/Settings";
import { Shipping } from "@/pages/Shipping";
import { Logs } from "@/pages/Logs";
import { ToastProvider } from "@/components/Toast";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireAuth() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8 text-center shadow-sm">
          <div className="text-2xl font-semibold tracking-tight">Sillage</div>
          <p className="mt-2 text-sm text-muted">Checking your dashboard session…</p>
          <Link className="mt-6 inline-flex rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink" to="/login">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }
  if (isError || !data?.ok) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function App() {
  const basename = import.meta.env.BASE_URL === "/" ? "/" : import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <BrowserRouter basename={basename}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route
              element={
                <TimezoneProvider>
                  <Layout />
                </TimezoneProvider>
              }
            >
              <Route index element={<Overview />} />
              <Route path="sync" element={<Sync />} />
              <Route path="products" element={<Products />} />
              <Route path="vendors" element={<Vendors />} />
              <Route path="orders" element={<Orders />} />
              <Route path="shipping" element={<Shipping />} />
              <Route path="secrets" element={<Secrets />} />
              <Route path="settings" element={<Settings />} />
              <Route path="logs" element={<Logs />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
