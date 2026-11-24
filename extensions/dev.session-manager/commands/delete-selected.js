export async function deleteSelectedSessions({
  selection, confirm, deleteFolder, deleteSession, isDeleted,
  onDeleted, clearSelection, afterDelete, isDescendant = () => false,
  run = execute => execute(() => {}), onProgress = () => {}
}) {
  if (!selection.length || !await confirm()) return false;
  const targets = selection.filter(item => !selection.some(parent =>
    parent.type === "folder" && parent.id !== item.id && isDescendant(parent.id, item.id)
  ));
  return run(async progress => {
    let completed = false;
    let count = 0;
    const acknowledged = [];
    try {
      for (const item of targets) {
        if (item.type === "folder") {
          if (!await deleteFolder(item.id)) return false;
        } else if (!isDeleted(item.id)) {
          await deleteSession(item.id);
          acknowledged.push(item.id);
        }
        progress(++count);
        onProgress(count, item);
        afterDelete();
      }
      completed = true;
      return true;
    } finally {
      if (acknowledged.length) {
        // The deletion receipt does not depend on loading a replacement editor.
        void Promise.resolve(onDeleted(acknowledged)).catch(error =>
          console.warn("[sessions] replacement after deletion failed", error));
      }
      if (completed) clearSelection();
      afterDelete();
    }
  }).catch(() => false);
}
