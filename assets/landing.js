/* ============================================================
   落地页：只负责展示总览统计与入口
   ============================================================ */

(async function main() {
  renderTopbar([]);
  try {
    const data = await loadPapers();
    const s = data.stats || {};
    document.getElementById("stat-papers").textContent = s.papers ?? "—";
    document.getElementById("stat-questions").textContent = s.questions ?? "—";
    document.getElementById("stat-images").textContent = s.images ?? "—";
  } catch (err) {
    // 统计拿不到不影响入口可用，静默降级
    console.warn("统计数据加载失败：", err);
    ["stat-papers", "stat-questions", "stat-images"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    });
  }
})();
