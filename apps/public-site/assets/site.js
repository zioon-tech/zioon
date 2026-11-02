(() => {
  "use strict";
  const documentRoot = document.documentElement;
  documentRoot.classList.add("js");
  const menuToggle = document.querySelector(".menu-toggle");
  const menu = document.querySelector("#site-navigation");
  const closeMenu = () => {
    menu?.removeAttribute("data-open");
    menuToggle?.setAttribute("aria-expanded", "false");
  };
  menuToggle?.addEventListener("click", () => {
    const open = menuToggle.getAttribute("aria-expanded") !== "true";
    menuToggle.setAttribute("aria-expanded", String(open));
    menu.dataset.open = String(open);
  });
  menu?.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuToggle?.getAttribute("aria-expanded") === "true") {
      closeMenu();
      menuToggle.focus();
    }
  });
  const mobile = matchMedia("(max-width: 680px)");
  const docsNavigation = document.querySelector(".docs-navigation");
  const setNavigation = () => {
    if (docsNavigation) docsNavigation.open = !mobile.matches;
    closeMenu();
  };
  setNavigation();
  mobile.addEventListener("change", setNavigation);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if ("IntersectionObserver" in window && !reducedMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.remove("reveal-pending");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
    document.querySelectorAll(".reveal").forEach((element) => {
      element.classList.add("reveal-pending");
      observer.observe(element);
    });
  }

  const tocLinks = [...document.querySelectorAll("[data-toc-link]")];
  const markSection = (sectionId) => tocLinks.forEach((anchor) => {
    if (new URL(anchor.href).hash === `#${sectionId}`) anchor.setAttribute("aria-current", "location");
    else anchor.removeAttribute("aria-current");
  });
  if (tocLinks.length && "IntersectionObserver" in window) {
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      });
      const first = [...visible].sort((a, b) => a[1] - b[1])[0];
      if (first) markSection(first[0]);
    }, { rootMargin: "-100px 0px -55% 0px" });
    document.querySelectorAll(".article-section").forEach((element) => observer.observe(element));
    if (location.hash) markSection(location.hash.slice(1));
    else markSection(document.querySelector(".article-section")?.id);
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.closest(".code-block").querySelector("pre code").textContent;
      const status = document.querySelector("#copy-status");
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(text);
        button.textContent = "已复制";
        status.textContent = "代码已复制到剪贴板。";
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(button.closest(".code-block").querySelector("pre code"));
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = "已选中";
        status.textContent = "代码已选中，请按 Ctrl+C 或 Command+C 复制。";
      }
      window.setTimeout(() => { button.textContent = "复制"; }, 2200);
    });
  });

  let indexPromise;
  const loadIndex = () => {
    if (!indexPromise) {
      indexPromise = fetch("/search-index.json").then((response) => {
        if (!response.ok) throw new Error("Index unavailable");
        return response.json();
      }).then((entries) => {
        if (!Array.isArray(entries)) throw new Error("Invalid index");
        return entries;
      }).catch((error) => {
        indexPromise = undefined;
        throw error;
      });
    }
    return indexPromise;
  };
  const rankResults = (entries, query) => {
    const terms = query.trim().toLocaleLowerCase().match(/[a-z0-9_.:/-]+|[\u4e00-\u9fff]+/g) || [];
    if (!terms.length) return [];
    const exact = [];
    const related = [];
    for (const entry of entries) {
      const title = `${entry.title} ${entry.pageTitle}`.toLocaleLowerCase();
      const description = entry.description.toLocaleLowerCase();
      const text = entry.text.toLocaleLowerCase();
      let score = 0, matched = 0, partial = 0;
      for (const term of terms) {
        if (title.includes(term)) { score += 20; matched++; }
        else if (description.includes(term)) { score += 8; matched++; }
        else if (text.includes(term)) { score += 3; matched++; }
        else if (/^[\u4e00-\u9fff]{3,}$/.test(term)) {
          let pairs = 0;
          for (let position = 0; position < term.length - 1; position++) {
            const pair = term.slice(position, position + 2);
            if (title.includes(pair)) { score += 4; pairs++; }
            else if (description.includes(pair)) { score++; pairs++; }
          }
          if (pairs) partial++;
        }
      }
      if (matched === terms.length) exact.push({ entry, score });
      else if (matched + partial === terms.length) related.push({ entry, score });
    }
    return (exact.length ? exact : related).sort((a, b) => b.score - a.score).slice(0, 12).map((result) => result.entry);
  };
  const renderResults = (container, entries) => {
    container.replaceChildren();
    entries.forEach((entry) => {
      const anchor = document.createElement("a");
      anchor.className = "search-result";
      // The search index is local data. Accept only links back into the Docs tree.
      const url = new URL(entry.url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith("/docs/")) return;
      anchor.href = url.pathname + url.hash;
      const parent = document.createElement("span");
      parent.textContent = `${entry.group} / ${entry.pageTitle}`;
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const description = document.createElement("p");
      description.textContent = entry.description;
      anchor.append(parent, title, description);
      container.append(anchor);
    });
  };
  const bindSearch = (input, results, status, showAll = false) => {
    let generation = 0;
    const update = async () => {
      const current = ++generation;
      const query = input.value.trim().slice(0, 180);
      if (!query && !showAll) {
        results.replaceChildren();
        status.textContent = "输入关键词，查找操作说明。";
        return;
      }
      status.textContent = "正在查找…";
      try {
        const entries = await loadIndex();
        if (current !== generation) return;
        const matches = query ? rankResults(entries, query) : entries.filter((entry) => !entry.url.includes("#"));
        renderResults(results, matches);
        status.textContent = matches.length ? `找到 ${matches.length} 条说明。` : "没有找到相关说明。换一个关键词，或浏览文档目录。";
      } catch {
        if (current !== generation) return;
        status.textContent = "暂时无法加载搜索。请重试，或通过文档目录查找。";
        // Keep the server-rendered list as a fallback on the dedicated search page.
        if (!showAll) results.replaceChildren();
      }
    };
    input.addEventListener("input", update);
    return update;
  };

  const dialog = document.querySelector("#search-dialog");
  const dialogInput = document.querySelector("#dialog-query");
  const dialogResults = document.querySelector("#dialog-results");
  const dialogStatus = document.querySelector("#search-status");
  const updateDialog = bindSearch(dialogInput, dialogResults, dialogStatus);
  let searchOpener;
  const openSearch = () => {
    if (typeof dialog.showModal !== "function") { location.assign("/docs/search/"); return; }
    searchOpener = mobile.matches && menu.contains(document.activeElement) ? menuToggle : document.activeElement;
    if (!dialog.open) dialog.showModal();
    documentRoot.classList.add("search-open");
    dialogInput.focus();
    dialogInput.select();
    updateDialog();
  };
  const closeSearch = () => dialog.close();
  document.querySelectorAll("[data-open-search]").forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openSearch();
    });
  });
  document.querySelector("[data-close-search]").addEventListener("click", closeSearch);
  dialog.addEventListener("close", () => {
    documentRoot.classList.remove("search-open");
    if (searchOpener instanceof HTMLElement && searchOpener.isConnected) searchOpener.focus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSearch();
  });
  const selectedResult = () => dialogResults.querySelector('[aria-current="true"]');
  dialogInput.addEventListener("keydown", (event) => {
    const anchors = [...dialogResults.querySelectorAll("a")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!anchors.length) return;
      event.preventDefault();
      const position = anchors.indexOf(selectedResult());
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = position < 0 ? (step > 0 ? 0 : anchors.length - 1) : (position + step + anchors.length) % anchors.length;
      anchors.forEach((anchor) => anchor.removeAttribute("aria-current"));
      anchors[next].setAttribute("aria-current", "true");
      anchors[next].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && anchors.length) {
      event.preventDefault();
      (selectedResult() || anchors[0]).click();
    }
  });
  document.addEventListener("keydown", (event) => {
    const editing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]");
    if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
      || (event.key === "/" && !editing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
      event.preventDefault();
      closeMenu();
      openSearch();
    }
  });

  const pageInput = document.querySelector("#page-query");
  if (pageInput) {
    pageInput.value = (new URL(location.href).searchParams.get("q") || "").slice(0, 180);
    const updatePage = bindSearch(pageInput, document.querySelector("#page-results"), document.querySelector("#page-search-status"), true);
    document.querySelector("#page-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const url = new URL(location.href);
      if (pageInput.value.trim()) url.searchParams.set("q", pageInput.value.trim().slice(0, 180));
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
      updatePage();
    });
    updatePage();
  }
})();
