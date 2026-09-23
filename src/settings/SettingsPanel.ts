/**
 * SettingsPanel — 设置面板 UI
 *
 * 使用 React 构建统一的 Settings Center 外壳，
 * 同时兼容旧的 render(container) 设置项注册方式。
 */

import React from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { SettingsShell } from "./SettingsShell";

const STYLE_ID = "zion-settings-panel-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.zion-settings-mask{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.42);display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(1px)}
:root[data-theme="light"] .zion-settings-mask{background:rgba(0,0,0,.18)}
.zion-settings-panel{--settings-bg:var(--panel,var(--bg,#1e1e1e));--settings-surface-bg:var(--panel,var(--bg,#1e1e1e));--settings-sidebar-bg:var(--editor-tabsbar-bg,var(--panel,var(--bg,#1e1e1e)));--settings-content-bg:var(--panel,var(--bg,#1e1e1e));--settings-input-bg:var(--editor-bg,var(--bg,var(--panel,#1e1e1e)));width:min(1000px,calc(100vw - 72px));height:min(680px,calc(100vh - 64px));background:var(--settings-bg);border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 88%, transparent);border-radius:8px;box-shadow:0 20px 54px rgba(0,0,0,.28),0 4px 14px rgba(0,0,0,.16);overflow:hidden;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:12px;color:var(--fg,#cccccc)}
.zion-settings-shell{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--settings-bg)}
.zion-settings-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px;padding:6px 10px 6px 12px;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent);background:var(--settings-surface-bg)}
.zion-settings-headings{min-width:0}
.zion-settings-eyebrow{display:none}
.zion-settings-title{margin:0;font-size:13px;line-height:1.2;font-weight:600;color:var(--fg,#cccccc)}
.zion-settings-subtitle{display:none}
.zion-settings-close{width:28px;height:28px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--fg,#cccccc);cursor:pointer;opacity:.68}
.zion-settings-close:hover{background:color-mix(in srgb,var(--border,#3c3c3c) 28%, transparent);opacity:1}
.zion-settings-toolbar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent);background:var(--settings-surface-bg)}
.zion-settings-search-wrap{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0}
.zion-settings-search-wrap>svg{position:absolute;left:9px;z-index:1;color:color-mix(in srgb,var(--fg,#cccccc) 46%, transparent);pointer-events:none}
.zion-settings-search{width:100%;height:28px;border-radius:5px;border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 88%, transparent);background:var(--settings-input-bg);color:var(--fg,#cccccc);padding:0 9px 0 30px;font-size:12px;outline:none;box-shadow:none}
.zion-settings-search:focus{border-color:color-mix(in srgb,var(--accent,#6272a4) 48%, var(--border,#3c3c3c));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#6272a4) 28%, transparent)}
.zion-settings-summary{flex:0 0 auto;font-size:11px;opacity:.62;white-space:nowrap}
.zion-settings-layout{display:grid;grid-template-columns:208px minmax(0,1fr);gap:0;flex:1;min-height:0}
.zion-settings-sidebar{padding:10px 0;border-right:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent);overflow:auto;background:color-mix(in srgb,var(--settings-sidebar-bg) 96%, var(--settings-content-bg) 4%)}
.zion-settings-sidebar-title{font-size:11px;font-weight:600;letter-spacing:.02em;opacity:.6;padding:0 14px 8px}
.zion-settings-sidebar-subtitle{display:none}
.zion-settings-sidebar-group{margin-bottom:10px}
.zion-settings-sidebar-group:last-child{margin-bottom:0}
.zion-settings-sidebar-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 14px 6px;font-size:10px;font-weight:600;letter-spacing:.02em;opacity:.52}
.zion-settings-sidebar-group-desc{display:none}
.zion-settings-nav{width:100%;min-height:30px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0;padding:6px 12px 6px 16px;border:none;border-left:2px solid transparent;border-radius:0;background:transparent;color:var(--fg,#cccccc);cursor:pointer;font-size:12px;text-align:left}
.zion-settings-nav:hover{background:color-mix(in srgb,var(--border,#3c3c3c) 18%, transparent)}
.zion-settings-nav.is-active{background:color-mix(in srgb,var(--accent,#6272a4) 10%, transparent);border-left-color:color-mix(in srgb,var(--accent,#6272a4) 72%, transparent)}
.zion-settings-nav-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.zion-settings-nav-label{font-size:12px;font-weight:500;color:var(--fg,#cccccc)}
.zion-settings-nav-desc{font-size:10px;line-height:1.35;opacity:.46}
.zion-settings-nav-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;padding:0 4px;border-radius:999px;background:transparent;font-size:10px;opacity:.5}
.zion-settings-content{overflow:auto;padding:16px 20px 20px;background:var(--settings-content-bg)}
.zion-settings-content::-webkit-scrollbar,.zion-settings-sidebar::-webkit-scrollbar{width:10px;height:10px}
.zion-settings-content::-webkit-scrollbar-track,.zion-settings-sidebar::-webkit-scrollbar-track{background:transparent}
.zion-settings-content::-webkit-scrollbar-thumb,.zion-settings-sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px;border:2px solid transparent;background-clip:content-box}
:root[data-theme="light"] .zion-settings-content::-webkit-scrollbar-thumb,:root[data-theme="light"] .zion-settings-sidebar::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);background-clip:content-box}
.zion-settings-category{margin-bottom:18px;max-width:880px}
.zion-settings-category:last-child{margin-bottom:0}
.zion-settings-category-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent)}
.zion-settings-category-label{font-size:17px;font-weight:600;color:var(--fg,#cccccc)}
.zion-settings-category-meta{margin-top:4px;font-size:11px;line-height:1.45;opacity:.56}
.zion-settings-section{margin-bottom:18px}
.zion-settings-section:last-child{margin-bottom:0}
.zion-settings-section-title{font-size:12px;font-weight:600;color:var(--fg,#cccccc);opacity:.88;margin-bottom:6px}
.zion-settings-section-desc{margin:0 0 6px;font-size:11px;line-height:1.4;opacity:.56}
.zion-settings-section-grid{display:flex;flex-direction:column}
.zion-settings-item{min-width:0}
.zion-settings-item.is-standard{display:block;padding:9px 0;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent)}
.zion-settings-item.is-standard:first-child{border-top:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent)}
.zion-settings-item.is-custom{padding:9px 0;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent)}
.zion-settings-item-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.zion-settings-item-head > div{min-width:0}
.zion-settings-item-title{margin:0;font-size:12px;font-weight:500;color:var(--fg,#cccccc)}
.zion-settings-item-id{margin-top:4px;font-size:10px;line-height:1.4;opacity:.42;font-family:var(--font-mono,monospace)}
.zion-settings-item-body{min-width:0}
.zion-settings-standalone{min-width:0}
.zion-settings-item-desc{margin:3px 0 0;font-size:11px;line-height:1.45;opacity:.7;max-width:72ch}
.zion-settings-legacy-host{min-width:0}
.zion-settings-item-error{margin-top:8px;font-size:11px;color:#ff6b6b}
.zion-settings-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:260px;border:1px dashed var(--border,#3c3c3c);opacity:.68}
.zion-settings-setting-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto}
.zion-settings-setting-badge{display:inline-flex;align-items:center;min-height:16px;padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--border,#3c3c3c) 24%, transparent);font-size:10px;letter-spacing:.02em;text-transform:uppercase;font-weight:600;opacity:.72}
.zion-settings-setting-badge.is-danger{background:rgba(248,81,73,.14);color:#ff7b72}
.zion-settings-setting-badge.is-experimental{background:rgba(210,153,34,.14);color:#e3b341}
.zion-settings-standard-row{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:12px}
.zion-settings-standard-row.is-wide{grid-template-columns:1fr;gap:8px}
.zion-settings-standard-main{min-width:0}
.zion-settings-standard-control{display:flex;align-items:flex-start;justify-content:flex-end}
.zion-settings-standard-control.is-compact{justify-content:flex-end}
.zion-settings-standard-control.is-wide{justify-content:stretch;max-width:720px}
.zion-settings-setting-control{display:flex;flex-direction:column;gap:8px}
.zion-settings-setting-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px}
.zion-settings-inline-help{font-size:11px;line-height:1.45;opacity:.6}
.zion-settings-inline-actions{display:flex;gap:8px;flex-wrap:wrap}
.zion-settings-toggle{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:500}
.zion-settings-toggle input[type="checkbox"]{width:16px;height:16px}
.zion-settings-multiselect{display:flex;flex-direction:column;gap:8px;align-items:flex-start;width:min(100%,720px)}
.zion-settings-multiselect-option{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 56%, transparent);border-radius:8px;background:transparent;font-size:11px;line-height:1.4;min-width:220px}
.zion-settings-multiselect-option input[type="checkbox"]{width:14px;height:14px;flex:0 0 auto}
.zion-settings-multiselect-label{font-weight:500}
.zion-settings-multiselect-empty{font-size:11px;opacity:.56}
.zion-settings-form-scope{display:flex;flex-direction:column;gap:8px}
.zion-settings-form-scope input[type="text"],.zion-settings-form-scope input[type="password"],.zion-settings-form-scope input[type="number"],.zion-settings-form-scope select,.zion-settings-form-scope textarea{width:100%;min-height:24px;border-radius:4px;border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 90%, transparent) !important;background:color-mix(in srgb,var(--panel,#1e1e1e) 88%, var(--bg,#1e1e1e) 12%) !important;color:var(--fg,#cccccc) !important;padding:0 8px !important;box-sizing:border-box;font-size:12px;outline:none}
.zion-settings-form-scope textarea{padding:6px 8px !important;min-height:58px}
.zion-settings-form-scope input[type="text"]:focus,.zion-settings-form-scope input[type="password"]:focus,.zion-settings-form-scope input[type="number"]:focus,.zion-settings-form-scope select:focus,.zion-settings-form-scope textarea:focus{border-color:color-mix(in srgb,var(--accent,#6272a4) 48%, var(--border,#3c3c3c)) !important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#6272a4) 25%, transparent)}
.zion-settings-form-scope button{min-height:26px;border-radius:4px;border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 88%, transparent) !important;background:color-mix(in srgb,var(--panel,#1e1e1e) 90%, var(--border,#3c3c3c) 10%) !important;color:color-mix(in srgb,var(--fg,#cccccc) 92%, var(--border,#3c3c3c)) !important;padding:0 10px !important;font-size:12px !important;font-weight:500;cursor:pointer;box-shadow:none !important}
.zion-settings-form-scope button:hover{background:color-mix(in srgb,var(--panel,#1e1e1e) 82%, var(--border,#3c3c3c) 18%) !important;border-color:color-mix(in srgb,var(--border,#3c3c3c) 70%, transparent) !important}
.zion-settings-form-scope button:disabled{opacity:.45;cursor:not-allowed}
.zion-settings-form-scope button.primary,.zion-settings-form-scope .primary{border-color:color-mix(in srgb,var(--accent,#6272a4) 30%, var(--border,#3c3c3c)) !important;color:color-mix(in srgb,var(--fg,#cccccc) 96%, var(--accent,#6272a4) 4%) !important;background:color-mix(in srgb,var(--panel,#1e1e1e) 84%, var(--accent,#6272a4) 16%) !important}
.zion-settings-form-scope button.primary:hover,.zion-settings-form-scope .primary:hover{background:color-mix(in srgb,var(--panel,#1e1e1e) 78%, var(--accent,#6272a4) 22%) !important;border-color:color-mix(in srgb,var(--accent,#6272a4) 42%, var(--border,#3c3c3c)) !important}
.zion-settings-link-button{border:none !important;background:transparent !important;color:color-mix(in srgb,var(--fg,#cccccc) 72%, var(--accent,#6272a4) 28%) !important;min-height:auto !important;padding:0 !important;font-size:11px !important}
.zion-settings-link-button:hover{color:color-mix(in srgb,var(--fg,#cccccc) 58%, var(--accent,#6272a4) 42%) !important;text-decoration:underline}
.zion-settings-form-scope input[type="checkbox"]{accent-color:var(--accent,#6272a4)}
.zion-settings-form-scope .mail-cfg-row,.zion-settings-form-scope .svc-url-row,.zion-settings-form-scope .sk-cfg-path-row,.zion-settings-form-scope .fs-cfg-entry{margin-bottom:0 !important}
.zion-settings-form-scope .mail-cfg-actions,.zion-settings-form-scope .svc-url-actions,.zion-settings-form-scope .sk-cfg-actions,.zion-settings-form-scope .fs-cfg-actions{margin-top:4px !important;display:flex;flex-wrap:wrap;gap:8px}
.lc-models{display:flex;flex-direction:column;gap:16px}
.lc-models-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:4px 0 2px}
.lc-models-toolbar、、
‘-main{min-width:0}
.lc-models-toolbar-title{font-size:15px;font-weight:600;letter-spacing:.01em}
.lc-models-toolbar-meta{margin-top:4px;font-size:11px;line-height:1.45;opacity:.58}
.lc-models-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
.lc-models-workbench{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;min-height:480px}
.lc-models-sidebar,.lc-models-detail{background:transparent}
.lc-models-sidebar{padding:4px 0 2px}
.lc-models-sidebar-group{margin-bottom:20px}
.lc-models-sidebar-group:last-child{margin-bottom:0}
.lc-models-sidebar-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;padding:0 8px}
.lc-models-sidebar-group-title{font-size:10px;font-weight:600;letter-spacing:.04em;opacity:.46;text-transform:uppercase}
.lc-models-sidebar-list{display:flex;flex-direction:column;gap:2px}
.lc-models-sidebar-item{position:relative;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:9px 12px;border:none !important;border-radius:10px;background:transparent !important;text-align:left;transition:background .14s ease,color .14s ease}
.lc-models-sidebar-item::before{content:"";position:absolute;left:4px;top:7px;bottom:7px;width:2px;border-radius:999px;background:transparent;transition:background .14s ease}
.lc-models-sidebar-item:hover{background:color-mix(in srgb,var(--border,#3c3c3c) 7%, transparent) !important}
.lc-models-sidebar-item.is-selected{background:color-mix(in srgb,var(--accent,#6272a4) 8%, transparent) !important}
.lc-models-sidebar-item.is-selected::before{background:color-mix(in srgb,var(--accent,#6272a4) 60%, transparent)}
.lc-models-sidebar-item.is-active .lc-models-sidebar-item-title{color:color-mix(in srgb,var(--fg,#cccccc) 90%, var(--accent,#6272a4) 10%)}
.lc-models-sidebar-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.lc-models-sidebar-item-title{font-size:12px;font-weight:500;line-height:1.35;padding-left:2px}
.lc-models-sidebar-item-subtitle{font-size:10px;line-height:1.35;opacity:.42;font-family:var(--font-mono,monospace);word-break:break-all}
.lc-models-quiet-button{min-height:auto !important;padding:0 !important;border:none !important;background:transparent !important;font-size:11px !important;opacity:.66}
.lc-models-quiet-button:hover{opacity:1;text-decoration:underline}
.lc-models-detail{padding:0;display:flex;flex-direction:column;gap:14px}
.lc-models-detail-stack{display:flex;flex-direction:column;gap:12px}
.lc-models-detail-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0 10px}
.lc-models-detail-title{font-size:18px;font-weight:600;letter-spacing:.01em}
.lc-models-detail-subtitle{margin-top:6px;font-size:11px;line-height:1.55;opacity:.6;max-width:62ch}
.lc-models-detail-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.lc-models-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
.lc-models-detail-card{border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 48%, transparent);border-radius:10px;padding:12px 14px;background:color-mix(in srgb,var(--panel,#1e1e1e) 98%, transparent)}
.lc-models-detail-card.is-subtle{background:color-mix(in srgb,var(--panel,#1e1e1e) 72%, transparent);border-color:color-mix(in srgb,var(--border,#3c3c3c) 30%, transparent)}
.lc-models-detail-section-title{font-size:12px;font-weight:600}
.lc-models-detail-section-desc{margin-top:4px;font-size:11px;line-height:1.5;opacity:.56;max-width:56ch}
.lc-models-row-meta{font-size:10px;line-height:1.2;opacity:.58;font-family:var(--font-mono,monospace)}
.lc-models-pill{display:inline-flex;align-items:center;min-height:18px;padding:0 7px;border-radius:999px;font-size:10px;opacity:.82;background:color-mix(in srgb,var(--accent,#6272a4) 14%, transparent)}
.lc-models-pill.is-warn{background:rgba(210,153,34,.14);color:#e3b341}
.lc-models-status-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;margin-top:10px}
.lc-models-status-row{display:flex;flex-direction:column;gap:3px;min-width:0}
.lc-models-status-label{font-size:10px;letter-spacing:.03em;opacity:.48;text-transform:uppercase}
.lc-models-status-value{font-size:12px;line-height:1.45;word-break:break-word}
.lc-models-form{display:grid;grid-template-columns:1fr;gap:10px;margin-top:10px}
.lc-models-form.two-cols{grid-template-columns:repeat(2,minmax(0,1fr))}
.lc-models-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.lc-models-field.wide{grid-column:1 / -1}
.lc-models-field>span{font-size:10px;letter-spacing:.03em;opacity:.58;text-transform:uppercase}
.lc-models-checks{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.lc-models-check{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:5px 8px;border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 52%, transparent);border-radius:999px;background:transparent}
.lc-models-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.lc-models-empty{padding:8px 10px;border:1px dashed color-mix(in srgb,var(--border,#3c3c3c) 54%, transparent);border-radius:8px;font-size:11px;opacity:.56}
.lc-models-advanced{border:1px solid color-mix(in srgb,var(--border,#3c3c3c) 40%, transparent);border-radius:10px;padding:0 14px 12px;background:color-mix(in srgb,var(--panel,#1e1e1e) 62%, transparent)}
.lc-models-advanced-summary{list-style:none;cursor:pointer;padding:12px 0 10px;font-size:12px;font-weight:600}
.lc-models-advanced-summary::-webkit-details-marker{display:none}
.lc-models-status{font-size:11px;line-height:1.5;opacity:.62;padding:0 2px}
.lc-tools{display:flex;flex-direction:column;gap:14px}
.lc-tools-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0 2px}
.lc-tools-title{font-size:18px;font-weight:600;letter-spacing:.01em}
.lc-tools-subtitle{margin-top:6px;font-size:11px;line-height:1.55;opacity:.58;max-width:60ch}
.lc-tools-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
.lc-tools-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0 2px}
.lc-tools-summary-main{display:flex;align-items:baseline;gap:8px;min-width:0}
.lc-tools-summary-number{font-size:20px;font-weight:600;letter-spacing:-.02em}
.lc-tools-summary-text{font-size:11px;line-height:1.45;opacity:.58}
.lc-tools-summary-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.lc-tools-panel{border-top:1px solid color-mix(in srgb,var(--border,#3c3c3c) 28%, transparent);padding-top:12px}
.lc-tools-section-title{font-size:12px;font-weight:600}
.lc-tools-section-desc{margin-top:4px;font-size:11px;line-height:1.5;opacity:.56;max-width:56ch}
.lc-tools-list{display:flex;flex-direction:column;margin-top:14px}
.lc-tools-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 18%, transparent)}
.lc-tools-row:first-child{border-top:1px solid color-mix(in srgb,var(--border,#3c3c3c) 18%, transparent)}
.lc-tools-row-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.lc-tools-row-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.lc-tools-row-title{font-size:12px;font-weight:600;line-height:1.4}
.lc-tools-row-state{font-size:10px;line-height:1.2;opacity:.48}
.lc-tools-row-desc{font-size:11px;line-height:1.5;opacity:.62;max-width:64ch}
.lc-tools-row-meta{font-size:10px;line-height:1.3;opacity:.4;font-family:var(--font-mono,monospace)}
.lc-tools-toggle{display:inline-flex;align-items:center;justify-content:center;border:none !important;background:transparent !important;padding:0 !important;min-height:auto !important}
.lc-tools-toggle-track{position:relative;display:inline-flex;align-items:center;width:34px;height:20px;padding:2px;border-radius:999px;background:color-mix(in srgb,var(--border,#3c3c3c) 26%, transparent);transition:background .14s ease}
.lc-tools-toggle.is-enabled .lc-tools-toggle-track{background:color-mix(in srgb,var(--accent,#6272a4) 38%, transparent)}
.lc-tools-toggle-knob{width:16px;height:16px;border-radius:999px;background:color-mix(in srgb,var(--fg,#cccccc) 92%, transparent);transform:translateX(0);transition:transform .14s ease}
.lc-tools-toggle.is-enabled .lc-tools-toggle-knob{transform:translateX(14px)}
.lc-tools-empty{padding:8px 0;font-size:11px;opacity:.56}
@media (max-width: 900px){
  .zion-settings-panel{width:min(100vw - 16px,920px);height:min(100vh - 16px,720px)}
  .zion-settings-layout{grid-template-columns:1fr}
  .zion-settings-sidebar{display:flex;gap:8px;overflow:auto;padding:10px 12px;border-right:none;border-bottom:1px solid color-mix(in srgb,var(--border,#3c3c3c) 92%, transparent)}
  .zion-settings-sidebar-title,.zion-settings-sidebar-subtitle{display:none}
  .zion-settings-sidebar-group-title{padding:0 6px 4px}
  .zion-settings-nav{min-width:170px;margin-bottom:0;padding:6px 10px}
  .zion-settings-item.is-standard,.zion-settings-standard-row{grid-template-columns:1fr}
  .zion-settings-standard-control{justify-content:stretch}
  .lc-models-workbench{grid-template-columns:1fr;gap:16px}
  .lc-models-form.two-cols{grid-template-columns:1fr}
  .lc-models-status-grid{grid-template-columns:1fr}
  .lc-tools-summary{align-items:flex-start;flex-direction:column}
}
@media (max-width: 640px){
  .zion-settings-mask{padding:8px}
  .zion-settings-panel{width:100%;height:min(100vh - 16px,1000px);border-radius:4px}
  .zion-settings-topbar{padding:10px 12px}
  .zion-settings-toolbar{padding:8px 12px;flex-direction:column;align-items:stretch}
  .zion-settings-summary{white-space:normal}
  .zion-settings-content{padding:12px}
  .zion-settings-nav{min-width:150px}
  .zion-settings-item.is-standard,.zion-settings-item.is-custom{padding:10px 0}
  .lc-models-toolbar,.lc-models-detail-hero,.lc-tools-hero{flex-direction:column}
  .lc-models-sidebar,.lc-models-detail{padding:10px}
  .lc-models-sidebar-group-head{padding:0 4px}
  .lc-models-sidebar-item{padding:8px 10px}
  .lc-models-advanced{padding:0 12px 12px}
  .lc-tools-row{grid-template-columns:1fr;align-items:flex-start}
}
  `;
  document.head.appendChild(style);
}

let panelCreated = false;
let maskEl: HTMLDivElement | null = null;
let panelEl: HTMLDivElement | null = null;
let root: Root | null = null;
let isOpen = false;
let requestedPageId = "";

function ensurePanel() {
  if (panelCreated) return;
  panelCreated = true;
  injectStyles();

  maskEl = document.createElement("div");
  maskEl.className = "zion-settings-mask";

  panelEl = document.createElement("div");
  panelEl.className = "zion-settings-panel";

  maskEl.appendChild(panelEl);
  document.body.appendChild(maskEl);

  maskEl.addEventListener("mousedown", (e) => {
    if (e.target === maskEl) close();
  });
}

function renderApp() {
  if (!panelEl) return;
  if (!root) root = createRoot(panelEl);
  root.render(React.createElement(SettingsShell, {
    key: requestedPageId || "settings",
    onRequestClose: close,
    initialPageId: requestedPageId
  }));
}

export function open(pageId = "") {
  requestedPageId = String(pageId || "");
  ensurePanel();
  if (!maskEl) return;
  if (isOpen) {
    renderApp();
    return;
  }
  isOpen = true;
  renderApp();
  maskEl.style.display = "flex";
  document.addEventListener("keydown", onKeyDown);
}

export function close() {
  if (!maskEl || !isOpen) return;
  isOpen = false;
  maskEl.style.display = "none";
  document.removeEventListener("keydown", onKeyDown);
  if (root) {
    root.unmount();
    root = null;
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
