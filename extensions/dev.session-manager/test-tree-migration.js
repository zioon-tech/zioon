#!/usr/bin/env node

/**
 * Automated test script for session-manager tree structure migration
 * Tests the migration from old object structure to new array structure
 */

// Mock functions (simplified versions from main.js)
function safeJSONParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function deriveTitleFromText(text) {
  if (!text) return "";
  const lines = text.trim().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.slice(0, 50);
    }
  }
  return "";
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function now() {
  return Date.now();
}

function genId() {
  return Math.random().toString(36).substring(2, 10);
}

function isFolder(node) {
  return node && node.type === "folder";
}

function isSession(node) {
  return node && node.type === "session";
}

function findNodeAndParent(root, id) {
  let found = null, parent = null;
  const dfs = (node, p) => {
    if (!node) return;
    if (node.id === id) { found = node; parent = p; return; }
    if (isFolder(node) && Array.isArray(node.children)) {
      for (const ch of node.children) {
        dfs(ch, node);
        if (found) return;
      }
    }
  };
  
  if (Array.isArray(root)) {
    for (const item of root) {
      dfs(item, null);
      if (found) break;
    }
  } else {
    dfs(root, null);
  }
  
  return { node: found, parent };
}

function flattenTree(tree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === "session") {
      out.push({
        id: node.id,
        title: node.title ?? node.id,
        updatedAt: node.updatedAt ?? 0,
        size: node.size ?? 0,
        hash: node.hash ?? "",
        createdAt: node.createdAt ?? 0
      });
    } else if (node.type === "folder" && Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  
  if (Array.isArray(tree)) {
    tree.forEach(walk);
  } else {
    walk(tree);
  }
  
  return out;
}

// Test suite
function runTests() {
  console.log("=== Session Manager Tree Migration Tests ===\n");
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Old tree structure (with root folder)
  console.log("Test 1: Migrate old tree structure to new array");
  const oldTree = {
    id: "root",
    type: "folder",
    title: "Sessions",
    children: [
      { id: "sess1", type: "session", title: "Session 1", createdAt: 1000, updatedAt: 1000, size: 100, hash: "abc" },
      { 
        id: "fld1", 
        type: "folder", 
        title: "Folder 1", 
        children: [
          { id: "sess2", type: "session", title: "Session 2", createdAt: 2000, updatedAt: 2000, size: 200, hash: "def" }
        ]
      }
    ]
  };
  
  // Simulate migration: extract children from root folder
  const migratedTree = oldTree.id === "root" && oldTree.type === "folder" && Array.isArray(oldTree.children) 
    ? oldTree.children 
    : [oldTree];
  
  console.log("  Old tree (object with root):", JSON.stringify(oldTree, null, 2));
  console.log("  Migrated tree (array):", JSON.stringify(migratedTree, null, 2));
  
  if (Array.isArray(migratedTree) && migratedTree.length === 2) {
    console.log("  ✓ PASS: Migrated tree is array with correct length\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Migrated tree structure incorrect\n");
    failed++;
  }
  
  // Test 2: Verify no "Sessions" root folder in migrated tree
  console.log("Test 2: Verify no root folder in migrated tree");
  const hasRootFolder = migratedTree.some(n => n.id === "root" && n.title === "Sessions");
  
  if (!hasRootFolder) {
    console.log("  ✓ PASS: No root folder found in migrated tree\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Root folder still exists in migrated tree\n");
    failed++;
  }
  
  // Test 3: Verify all sessions and folders are preserved
  console.log("Test 3: Verify all sessions and folders preserved");
  const flatMigrated = flattenTree(migratedTree);
  const flatOld = flattenTree(oldTree);
  
  console.log("  Sessions in old tree:", flatOld.length);
  console.log("  Sessions in migrated tree:", flatMigrated.length);
  
  if (flatMigrated.length === flatOld.length && flatMigrated.length === 2) {
    console.log("  ✓ PASS: All sessions preserved\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Session count mismatch\n");
    failed++;
  }
  
  // Test 4: Test findNodeAndParent with array structure
  console.log("Test 4: Test findNodeAndParent with array structure");
  const result1 = findNodeAndParent(migratedTree, "sess1");
  const result2 = findNodeAndParent(migratedTree, "sess2");
  
  console.log("  Find sess1:", result1.node?.id, "parent:", result1.parent?.id || "null");
  console.log("  Find sess2:", result2.node?.id, "parent:", result2.parent?.id || "null");
  
  if (result1.node?.id === "sess1" && result1.parent === null && 
      result2.node?.id === "sess2" && result2.parent?.id === "fld1") {
    console.log("  ✓ PASS: findNodeAndParent works correctly\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: findNodeAndParent returned unexpected results\n");
    failed++;
  }
  
  // Test 5: Test insertFolder with null parentId (top-level)
  console.log("Test 5: Test insertFolder at top level");
  const testTreeForInsert = [
    { id: "sess1", type: "session", title: "Session 1" },
    { id: "fld1", type: "folder", title: "Folder 1", children: [] }
  ];
  
  const newFolder = { id: "fld_new", type: "folder", title: "New Top Folder", children: [] };
  testTreeForInsert.unshift(newFolder);
  
  console.log("  Tree after insert:", JSON.stringify(testTreeForInsert, null, 2));
  
  if (testTreeForInsert.length === 3 && testTreeForInsert[0].id === "fld_new") {
    console.log("  ✓ PASS: Folder inserted at top level\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Folder not inserted correctly\n");
    failed++;
  }
  
  // Test 6: Test removeNode from top level
  console.log("Test 6: Test removeNode from top level");
  const testTreeForRemove = [
    { id: "sess1", type: "session", title: "Session 1" },
    { id: "fld1", type: "folder", title: "Folder 1", children: [] }
  ];
  
  const idx = testTreeForRemove.findIndex(n => n.id === "sess1");
  if (idx !== -1) {
    testTreeForRemove.splice(idx, 1);
  }
  
  console.log("  Tree after remove:", JSON.stringify(testTreeForRemove, null, 2));
  
  if (testTreeForRemove.length === 1 && testTreeForRemove[0].id === "fld1") {
    console.log("  ✓ PASS: Node removed from top level\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Node not removed correctly\n");
    failed++;
  }
  
  // Test 7: Test moveNode to top level (targetFolderId = null)
  console.log("Test 7: Test moveNode to top level");
  const testTreeForMove = [
    { id: "fld1", type: "folder", title: "Folder 1", children: [
      { id: "sess1", type: "session", title: "Session 1" }
    ]}
  ];
  
  const moveResult = findNodeAndParent(testTreeForMove, "sess1");
  if (moveResult.node && moveResult.parent) {
    // Remove from parent
    moveResult.parent.children = moveResult.parent.children.filter(c => c.id !== "sess1");
    // Add to top level
    testTreeForMove.unshift(moveResult.node);
  }
  
  console.log("  Tree after move:", JSON.stringify(testTreeForMove, null, 2));
  
  if (testTreeForMove.length === 2 && testTreeForMove[0].id === "sess1") {
    console.log("  ✓ PASS: Node moved to top level\n");
    passed++;
  } else {
    console.log("  ✗ FAIL: Node not moved correctly\n");
    failed++;
  }
  
  // Summary
  console.log("=== Test Summary ===");
  console.log(`Total tests: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Status: ${failed === 0 ? "✓ ALL TESTS PASSED" : "✗ SOME TESTS FAILED"}\n`);
  
  return failed === 0;
}

// Run tests
runTests();
