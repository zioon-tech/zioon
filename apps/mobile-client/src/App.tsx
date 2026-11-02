import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthBoundary } from "./AuthBoundary";
import { LoadingState } from "./components";

const SessionsScreen = lazy(() =>
  import("./ChatScreens").then((module) => ({ default: module.SessionsScreen })));
const ConversationScreen = lazy(() =>
  import("./ChatScreens").then((module) => ({ default: module.ConversationScreen })));
const WorkScreen = lazy(() =>
  import("./WorkScreens").then((module) => ({ default: module.WorkScreen })));
const RunDetailScreen = lazy(() =>
  import("./WorkScreens").then((module) => ({ default: module.RunDetailScreen })));
const SchedulerEditorScreen = lazy(() =>
  import("./WorkScreens").then((module) => ({ default: module.SchedulerEditorScreen })));
const SchedulerTaskDetailScreen = lazy(() =>
  import("./WorkScreens").then((module) => ({ default: module.SchedulerTaskDetailScreen })));
const SchedulerRunDetailScreen = lazy(() =>
  import("./WorkScreens").then((module) => ({ default: module.SchedulerRunDetailScreen })));
const TerminalsScreen = lazy(() =>
  import("./TerminalScreens").then((module) => ({ default: module.TerminalsScreen })));
const TerminalDetailScreen = lazy(() =>
  import("./TerminalScreens").then((module) => ({ default: module.TerminalDetailScreen })));
const MoreScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.MoreScreen })));
const AccountScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.AccountScreen })));
const FilesScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.FilesScreen })));
const CapabilitiesScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.CapabilitiesScreen })));
const PluginsScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.PluginsScreen })));
const ModelsScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.ModelsScreen })));
const KnowledgeScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.KnowledgeScreen })));
const CommentsScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.CommentsScreen })));
const DevicesScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.DevicesScreen })));
const SettingsScreen = lazy(() =>
  import("./MoreScreens").then((module) => ({ default: module.SettingsScreen })));

export function App() {
  return (
    <AuthBoundary>
      <Suspense fallback={<LoadingState label="正在打开页面" />}>
        <Routes>
          <Route path="/" element={<Navigate replace to="/chats" />} />
          <Route path="/chats" element={<SessionsScreen />} />
          <Route path="/chat/:sessionId" element={<ConversationScreen />} />
          <Route path="/work" element={<WorkScreen />} />
          <Route path="/run/:runId" element={<RunDetailScreen />} />
          <Route path="/scheduler/new" element={<SchedulerEditorScreen />} />
          <Route path="/scheduler/:taskId" element={<SchedulerTaskDetailScreen />} />
          <Route path="/scheduler/:taskId/runs/:schedulerRunId" element={<SchedulerRunDetailScreen />} />
          <Route path="/terminals" element={<TerminalsScreen />} />
          <Route path="/terminal/:sessionId" element={<TerminalDetailScreen />} />
          <Route path="/more" element={<MoreScreen />} />
          <Route path="/account" element={<AccountScreen />} />
          <Route path="/files" element={<FilesScreen />} />
          <Route path="/capabilities" element={<CapabilitiesScreen />} />
          <Route path="/plugins" element={<PluginsScreen />} />
          <Route path="/models" element={<ModelsScreen />} />
          <Route path="/knowledge" element={<KnowledgeScreen />} />
          <Route path="/comments" element={<CommentsScreen />} />
          <Route path="/devices" element={<DevicesScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate replace to="/chats" />} />
        </Routes>
      </Suspense>
    </AuthBoundary>
  );
}
