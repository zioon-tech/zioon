import "@ant-design/v5-patch-for-react-19";
import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Marketplace } from "./marketplace";
import "./style.css";

const queryClient = new QueryClient({ defaultOptions: {
  queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: true },
  mutations: { retry: false }
} });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ConfigProvider locale={zhCN} theme={{ token: {
    colorPrimary: "#1677ff", colorText: "#1f2329", colorTextSecondary: "#646a73",
    colorBgLayout: "#f7f8fa", colorBorder: "#e5e6eb", borderRadius: 8,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 14, controlHeight: 36
  } }}><AntApp><QueryClientProvider client={queryClient}><BrowserRouter>
    <Marketplace />
  </BrowserRouter></QueryClientProvider></AntApp></ConfigProvider></React.StrictMode>
);
