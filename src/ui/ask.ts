// 「よろしいですか？」の確認。2026-11-22: 確認用リンク（Artifact）のように確認窓が開けない所では
// window.confirm がすぐ false を返し、プリセットも Clear All も効かなかった（Akira さんの指摘）。
// 窓が出ずにすぐ返ったとき（人が押すには短すぎる時間）は、確かめられないので進める。Undo で戻せる。
export function ask(msg: string): boolean {
  const t = performance.now();
  let ok = false;
  try {
    ok = window.confirm(msg);
  } catch {
    return true;
  }
  return ok || performance.now() - t < 30;
}
