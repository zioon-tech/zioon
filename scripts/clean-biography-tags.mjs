#!/usr/bin/env node
/* global console, process */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildBiographyDigest,
  buildBiographyFacets,
  normalizeBiographyLabel,
  parseBiographyEventsJsonl,
  serializeBiographyEventsJsonl
} from "../extensions/dev.identity/identity-core.js";

const PROJECT_ALIASES = {
  "avgen-daily": "音视频生成日报",
  "industry-daily": "跨行业日报",
  "llm-daily": "大模型日报",
  "hotspot-daily": "热点日报",
  "vod-highlight-clip": "短剧高光智剪",
  "vod短剧高光智剪调研": "短剧高光智剪",
  "vod短剧高光智剪": "短剧高光智剪",
  "vod-drama-highlight": "短剧高光智剪",
  "短剧高光智剪": "短剧高光智剪",
  "tv-projector-dangbei": "投影仪当贝",
  "当贝市场": "投影仪当贝",
  "极米投影仪": "投影仪当贝",
  "projector-security": "投影仪当贝",
  "局域网扫描投影仪": "投影仪当贝",
  "跨行业前沿进展日报": "跨行业日报",
  "爆款素材剪辑效果示例文档": "爆款素材剪辑",
  "素材剪辑效果文档": "爆款素材剪辑",
  "巨量短剧素材打码规则": "爆款素材剪辑",
  "las-service": "爆款素材剪辑",
  "ug-short-drama": "ug短剧",
  "短剧剪辑体系梳理": "ug短剧",
  "adx-crawler": "adx爬虫",
  "短剧投放": "adx爬虫",
  "adx短剧爬取": "adx爬虫",
  "ziniao": "adx爬虫",
  "interview-wangjianjin": "面试/王建金",
  "王建金面试": "面试/王建金",
  "面试/王建金": "面试/王建金",
  "王建金校招面试记录": "面试/王建金",
  "interview-feedback": "面试/王建金",
  "抖音tts实习": "面试/王建金",
  "语音翻译mtp": "面试/王建金",
  "las-viral-clip-gen": "las爆款剪辑",
  "mysql-ro": "mysql只读",
  "subtitle-erasure-research": "字幕擦除调研",
  "script-gen": "脚本生成",
  "podcast-generator": "播客生成器",
  "vscode-plugin": "vscode插件",
  "local-environment": "本地环境",
  "harness": "zion"
};

const TOPIC_ALIASES = {
  "daily-report": "日报",
  "agent-identity": "agent身份",
  "session-sidebar": "会话侧栏",
  "podcast": "播客",
  "tag-tree": "标签树",
  "video-generation": "视频生成",
  "web-scraping": "网页抓取",
  "task-system": "任务系统",
  "plugin-system": "插件系统",
  "data-source": "数据源",
  "data-sources": "数据源",
  "data-sourcing": "数据源",
  "source-fallback": "数据源",
  "compliance/content": "合规/内容",
  "documentation": "文档",
  "observability": "可观测性",
  "skill": "技能",
  "trace": "trace",
  "environment": "环境",
  "subtitle-erasure": "字幕擦除",
  "video-editing": "视频剪辑",
  "anti-crawling": "反爬",
  "biography": "biography",
  "customer": "客户",
  "device-discovery": "设备发现",
  "memory-system": "记忆系统",
  "self-improvement": "自改进",
  "short-drama": "短剧",
  "visual-system": "视觉系统",
  "automation": "自动化",
  "model-config": "模型配置",
  "model-integration": "模型接入",
  "model-landscape": "模型格局",
  "planning": "规划",
  "plugin-architecture": "插件架构",
  "rate-limit": "限流",
  "read-only": "只读",
  "research": "调研",
  "scheduled-task": "定时任务",
  "security/iot": "安全/iot",
  "task-audit": "任务审计",
  "tooling": "工具",
  "ark-invoke": "ark调用",
  "asset-location": "素材定位",
  "benchmark": "评测",
  "bug-fix": "bug修复",
  "code-review": "代码审查",
  "core-boundary": "核心边界",
  "cost": "成本",
  "data-storage": "数据存储",
  "download": "下载",
  "feishu-doc": "飞书文档",
  "file-io": "文件读写",
  "interview": "面试",
  "las-viral-clip-gen": "las爆款剪辑",
  "license": "许可证",
  "log-analysis": "日志分析",
  "model-release": "模型发布",
  "model-routing": "模型路由",
  "model-selection": "模型选型",
  "model-usage": "模型用量",
  "persistence": "持久化",
  "pipeline": "流水线",
  "quota": "配额",
  "sandbox": "沙箱",
  "search": "搜索",
  "short-drama/highlight": "短剧/高光",
  "scraping": "网页抓取",
  "crawler": "网页抓取",
  "data-scraping": "网页抓取",
  "rate-limiting": "限流",
  "podcast-generation": "播客",
  "scheduling": "定时任务",
  "env-path": "环境",
  "environment-path": "环境",
  "tool-environment": "环境",
  "file-write": "文件读写",
  "trace-logging": "trace",
  "self-improving": "自改进",
  "licensing": "许可证",
  "audio-tts": "tts",
  "censor": "合规/内容",
  "censorship": "合规/内容",
  "content-moderation": "合规/内容",
  "素材合规": "合规/内容",
  "出海合规": "合规/内容",
  "打码": "合规/内容",
  "打码规则": "合规/内容",
  "巨量审核": "合规/内容",
  "审核路径": "合规/内容",
  "ad-policy": "合规/内容",
  "gdpr": "合规/内容",
  "素材定位": "素材定位",
  "video-processing": "视频剪辑",
  "video-playback": "视频剪辑",
  "video-player": "视频剪辑",
  "media-event": "视频剪辑",
  "vod-highlight": "短剧/高光",
  "video-highlight": "短剧/高光",
  "vod": "短剧",
  "iot-security": "安全/iot",
  "exploit": "安全/iot",
  "port-exposure": "安全/iot",
  "unauth-api": "安全/iot",
  "vulnerability": "安全/iot",
  "sideload": "安全/iot",
  "security": "安全/iot",
  "lan-scan": "设备发现",
  "network-scanning": "设备发现",
  "mdns": "设备发现",
  "airplay": "设备发现",
  "projector": "设备发现",
  "candidate-assessment": "面试",
  "interview-feedback": "面试",
  "interview-notes": "面试",
  "skill-creation": "技能",
  "skill-design": "技能",
  "skill-contract": "技能",
  "code-audit": "代码审查",
  "customer-demand": "客户",
  "customer-needs": "客户",
  "direction-planning": "规划",
  "product-planning": "规划",
  "requirement-research": "调研",
  "research-workflow": "调研",
  "industry-research": "调研",
  "成本控制": "成本",
  "writing-style": "写作风格",
  "writing-tone": "写作风格",
  "style": "写作风格",
  "tool-quota": "配额",
  "3d-printing": "日报",
  "account-inventory": "账号盘点",
  "apple-silicon": "视频生成",
  "architecture": "核心边界",
  "audio-generation": "视频生成",
  "avgen": "日报",
  "browser-automation": "浏览器自动化",
  "cache-busting": "bug修复",
  "community-sentiment": "社区反馈",
  "configuration": "模型配置",
  "content-refresh": "日报",
  "data-augmentation": "数据增强",
  "data-collection": "数据源",
  "data-prep": "下载",
  "dataset": "下载",
  "device-management": "设备管理",
  "discrete-token": "离散token",
  "disk-usage": "磁盘占用",
  "distillation": "蒸馏",
  "editor-setup": "环境",
  "event-system": "trace",
  "example": "面试",
  "execution-log": "trace",
  "fact-check": "日报",
  "failure-analysis": "失败分析",
  "fallback": "网页抓取",
  "file-naming": "文件命名",
  "frontend": "视频剪辑",
  "image-reading": "图片读取",
  "install-channel": "安装通道",
  "json": "播客",
  "media-insert": "媒体插入",
  "mini-max-h": "视频生成",
  "minimal-viable": "trace",
  "open-source-video": "视频生成",
  "operator-landscape": "规划",
  "permissions": "权限",
  "role-ratio": "播客",
  "runtime-extraction": "运行时抽取",
  "script": "文件命名",
  "script-format": "播客",
  "search-strategy": "搜索",
  "semiconductor": "日报",
  "source-access": "数据源",
  "speech-translation": "语音翻译",
  "stats": "可观测性",
  "storage": "磁盘占用",
  "storyboard": "分镜",
  "system-diagnostics": "系统诊断",
  "template-limits": "ark调用",
  "tos": "短剧/高光",
  "vscode": "vscode",
  "wan": "模型发布",
  "web-fetch": "数据源",
  "workflow": "工具",
  "worktree": "worktree"
};

const SESSION_PROJECT_OVERRIDES = {
  "774pf5": "面试/王建金",
  "q5zjlj": "爆款素材剪辑/开头结尾评测/vod",
  "qqo553": "爆款素材剪辑/效果示例文档编辑"
};

function resolveEventsPath(args) {
  const explicit = args.find((arg) => !arg.startsWith("-"));
  return explicit
    ? path.resolve(explicit.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), ".zion-next/memory/biography/events.jsonl");
}

function aliasLabel(value, aliases) {
  const normalized = normalizeBiographyLabel(value);
  return normalizeBiographyLabel(aliases[normalized] || aliases[value] || normalized);
}

function inferProject(event) {
  const sessionProject = SESSION_PROJECT_OVERRIDES[String(event?.sessionId || "")];
  if (sessionProject) return normalizeBiographyLabel(sessionProject);
  const explicit = aliasLabel(event.project, PROJECT_ALIASES);
  if (explicit) return explicit;
  const summary = String(event.summary || "");
  if (/磁盘|Downloads|tmp|zip/.test(summary)) return "本地环境";
  if (/算子现状|爆款素材|打码|裂变/.test(summary)) return "爆款素材剪辑";
  if (/VS Code|Cursor|code 命令/.test(summary)) return "vscode插件";
  if (/王建金|面试/.test(summary)) return "面试/王建金";
  if (/字幕擦除|EraserDiT|ProPainter|Wan VACE/.test(summary)) return "字幕擦除调研";
  if (/Biography|蒸馏|索引|topic|project/.test(summary)) return "zion-next";
  return "";
}

function cleanEvents(events) {
  return events.map((event) => {
    const project = inferProject(event);
    const topics = Array.from(new Set(
      (event.topics || [])
        .map((topic) => aliasLabel(topic, TOPIC_ALIASES))
        .filter(Boolean)
    )).slice(0, 2);
    return { ...event, project, topics };
  });
}

function metrics(events) {
  const facets = buildBiographyFacets(events);
  return {
    events: events.length,
    projects: facets.projects.length,
    topics: facets.topics.length,
    projectSingletons: facets.projects.filter((item) => item.count === 1).length,
    topicSingletons: facets.topics.filter((item) => item.count === 1).length,
    avgTopicsPerEvent: Number((events.reduce((sum, event) => sum + (event.topics?.length || 0), 0) / Math.max(1, events.length)).toFixed(2))
  };
}

function formatMetrics(label, value) {
  return [
    `${label}:`,
    `  events: ${value.events}`,
    `  projects: ${value.projects} (${value.projectSingletons} singleton)`,
    `  topics: ${value.topics} (${value.topicSingletons} singleton)`,
    `  avgTopicsPerEvent: ${value.avgTopicsPerEvent}`
  ].join("\n");
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const eventsPath = resolveEventsPath(args.filter((arg) => arg !== "--apply"));
const digestPath = path.join(path.dirname(eventsPath), "digest.md");
const before = parseBiographyEventsJsonl(fs.readFileSync(eventsPath, "utf8"));
const after = cleanEvents(before);
const beforeMetrics = metrics(before);
const afterMetrics = metrics(after);

console.log(formatMetrics("before", beforeMetrics));
console.log(formatMetrics("after", afterMetrics));

if (!apply) {
  console.log("dry run only; pass --apply to backup and rewrite events.jsonl plus digest.md");
  process.exit(0);
}

const stamp = timestamp();
const eventsBackup = `${eventsPath}.backup-${stamp}`;
fs.copyFileSync(eventsPath, eventsBackup);
if (fs.existsSync(digestPath)) fs.copyFileSync(digestPath, `${digestPath}.backup-${stamp}`);
fs.writeFileSync(eventsPath, serializeBiographyEventsJsonl(after), "utf8");
fs.writeFileSync(digestPath, buildBiographyDigest(after), "utf8");
console.log(`wrote ${eventsPath}`);
console.log(`wrote ${digestPath}`);
console.log(`backup ${eventsBackup}`);
