import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";

export function MobileApp({ basePath = import.meta.env.BASE_URL }: { basePath?: string }) {
  const basename = basePath.replace(/\/+$/, "") || "/";
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry(failureCount, error) {
          const status = Number((error as { status?: number })?.status || 0);
          if ([401, 403, 404].includes(status)) return false;
          return failureCount < 2;
        },
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  }));
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
