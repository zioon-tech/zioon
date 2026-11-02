# Multi-Node Plugin Compatibility Verification

This is a focused follow-up to `MULTI-NODE-TERMINAL-ROUTING.md`.
No unrelated staged changes or deployment snapshots are part of this scope.

## Scope

```json
{
  "scope_type": "diff",
  "TARGETS": [
    {
      "file_path": "extensions/dev.plugins/runtime.js",
      "target_type": "file",
      "symbol": "activateRuntimePlugin",
      "locator": "line 21; registered tool invoke at line 29",
      "source": "diff_hunk",
      "reason": "Connect the new node_id schema to every Plugin Host action",
      "hunks": [{"old_start": 0, "old_lines": 0, "new_start": 1, "new_lines": 102}]
    },
    {
      "file_path": "apps/runtime/src/plugin-file-service.mjs",
      "target_type": "file",
      "symbol": "createPluginFileService",
      "locator": "line 83; nested invokeTool at line 91",
      "source": "diff_hunk",
      "reason": "Preserve the parent terminal allowlist and explicit target in nested file calls",
      "hunks": [{"old_start": 98, "old_lines": 1, "new_start": 98, "new_lines": 3}]
    }
  ],
  "diff_context": {
    "files": [
      {
        "file_path": "extensions/dev.plugins/runtime.js",
        "status": "A",
        "mode": "cached",
        "hunks": [{"old_start": 0, "old_lines": 0, "new_start": 1, "new_lines": 102}]
      },
      {
        "file_path": "apps/runtime/src/plugin-file-service.mjs",
        "status": "M",
        "mode": "cached",
        "hunks": [{"old_start": 98, "old_lines": 1, "new_start": 98, "new_lines": 3}]
      }
    ]
  },
  "fallback_notes": "The cached changes predate this follow-up. They establish the current code baseline, not authorship of all changes."
}
```

Language: JavaScript. Framework: existing Vitest 2.1.9, Node v22.18.0.
No project-level unit-test convention files were found. EXEC_SOURCE is empty.

## Defect Analysis

```json
{
  "BUG_MAP": [
    {
      "defect_type": "Business Gaps",
      "scenario": "[defect-probing] 指定 Plugin Host 节点后每个动作应传递目标且拒绝与父目标冲突",
      "description": "工具 schema 已提供 node_id，但 handler 忽略该参数。",
      "file_path": "extensions/dev.plugins/runtime.js",
      "target_func": "activateRuntimePlugin/invoke",
      "bug_range": "29-83",
      "evidence": "新增 Runtime handler 直接传原 runContext，未读取本轮 schema 新增的 node_id；多 Node 下请求仍无目标，或继续在与参数不同的父目标上执行。",
      "expect_outcome": "correct: forward selected node and preserve policy, reject conflicts before Host call; current: node_id ignored; verify all five actions and zero calls on conflict",
      "severity": "P1",
      "status": "confirmed",
      "resolution": "Fixed after test generation; unchanged assertions pass."
    },
    {
      "defect_type": "Security",
      "scenario": "[defect-probing] 插件文件操作不得指定父范围以外的终端或省略参数清空父范围",
      "description": "嵌套文件调用用可选 session_id 重建 allowlist，丢失父 Run 的终端约束。",
      "file_path": "apps/runtime/src/plugin-file-service.mjs",
      "target_func": "createPluginFileService/invokeTool",
      "bug_range": "98-106",
      "evidence": "终端选择 hunk 周围的 allowedTerminalSessionIds 仅由 args 或 terminalSessionId 生成；新的跨 Node 引用被直接当作子授权，未与父 global allowlist 求交，省略时则变成无限制空列表。",
      "expect_outcome": "correct: reject out-of-scope selection, use a sole authorized terminal, require explicit selection if several are allowed; current: scope replaced or erased; verify rejection before dispatch and exact forwarded policy",
      "severity": "P1",
      "status": "confirmed",
      "resolution": "Fixed after test generation; unchanged assertions pass."
    },
    {
      "defect_type": "Business Gaps",
      "scenario": "[defect-probing] 父 Run 的显式资源目标应在嵌套文件调用中保留",
      "description": "文件服务重建 invocation 时遗漏新路由契约中的 target。",
      "file_path": "apps/runtime/src/plugin-file-service.mjs",
      "target_func": "createPluginFileService/invokeTool",
      "bug_range": "113-119",
      "evidence": "多 Node 路由新增 target 约束，文件服务却只传 projectId；无 session_id 的显式 Node 调用因此变为歧义调用，有引用时也失去父目标冲突检查。",
      "expect_outcome": "correct: retain target for Broker validation; current: target omitted; verify exact target and unchanged parent context",
      "severity": "P1",
      "status": "confirmed",
      "resolution": "Fixed after test generation; unchanged assertions pass."
    }
  ]
}
```

All three candidates pass reachability, contract and code-evidence checks. They
describe the pre-fix baseline, not the status after implementation. Local Device
grants still apply; these findings do not imply arbitrary host access.

## Generated Cases

- `tests/plugins-runtime-tool.test.js`: eight new cases. Five actions retain the
  selected Node and parent policy, conflicting Node selection is rejected, invalid
  actions do not dispatch, and Host errors do not trigger a fallback.
- `apps/runtime/tests/plugin-file-service.test.js`: eleven new cases. Read/write
  calls reject unauthorized explicit or context terminals, use the sole allowed
  terminal, reject ambiguous scope, narrow an authorized selection, and retain
  the parent target.

## Validation

Round 1, before implementation fixes:

```sh
# Workspace root, 120-second outer timeout
perl -e 'alarm shift; exec @ARGV' 120 npm exec -- vitest run tests/plugins-runtime-tool.test.js --exclude '**/.deploy-tmp/**'
# apps/runtime, 120-second outer timeout
perl -e 'alarm shift; exec @ARGV' 120 npm exec -- vitest run tests/plugin-file-service.test.js
```

Both commands exit 1 with `new-test-failed`: respectively six and nine failures.
All fifteen failures map to the three confirmed candidates above. Existing six
cases pass; four of nineteen new cases pass (21.05%). No test assertions were
relaxed and no production source changed during the test-generation workflow.
The fifteen failures are retained as evidence for the implementation phase.

Coverage mode is `skip`: no user/project coverage gate and no flux execution.
`utree flush` was invoked after generation and exited 1 because the sandbox denied
writes to the external skill cache and temporary `.utree` directory. Its helper
duration is not used as a test result or a coverage measure.

## Implementation Recheck

After closing the test-generation workflow, production code was changed:

- `pluginsManage` merges `node_id` into a copied context and rejects conflicts.
- File calls validate the selected terminal against the parent's allowlist, infer
  only a sole allowed terminal, and pass a copied parent target to the Broker.
- All nineteen new cases and all six existing cases now pass without changing
  their assertions. The confirmed records above retain the historical evidence;
  they are not unresolved defects in the final source.

Final validation: Runtime Host 270, Connector 28, Runtime Core 22, Node protocol 7,
and selected Workbench/plugin compatibility 84, all passing. Runtime TypeScript
build passed. A first Host run overlapped the build's deletion of `dist`; rerunning
after build completion removed the transient missing-module failures.

Browser checks on the isolated fixture confirmed required Node selection,
cloud-only creation, nonduplicated Node labels and complete reference tooltips.
The full Workbench build remains blocked by the unrelated Node-only imports in
`dev.byteintl-model`; this follow-up does not modify that plugin or deploy remotely.
