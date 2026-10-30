(function () {
  var booted = false;
  var renderToken = 0;
  var latestPages = [];

  function pageStateMessage(current, total) {
    parent.postMessage({
      type: "libiaolink:overview-preview-pages",
      current: current,
      total: total,
    }, "*");
  }

  function reportCurrentPage(pages) {
    var current = 1;
    for (var index = 0; index < pages.length; index += 1) {
      var rect = pages[index].getBoundingClientRect();
      var absoluteTop = rect.top + window.scrollY;
      if (window.scrollY + 80 >= absoluteTop) {
        current = index + 1;
      }
    }
    pageStateMessage(current, pages.length);
  }

  function buildPages(source, pagesRoot, pageBodyRef, currentTableRef) {
    var sections = source.filter(function (node) {
      return node.tagName === "SECTION" && node.classList.contains("section");
    });
    var taskSection = null;
    sections.forEach(function (node) {
      if (node.querySelector("table.tasks") !== null || node.querySelector(".empty") !== null) {
        taskSection = node;
      }
    });
    var topBlocks = source.filter(function (node) {
      return node !== taskSection;
    });
    var taskTitle = taskSection === null ? null : taskSection.querySelector(".section__title");
    var taskTable = taskSection === null ? null : taskSection.querySelector("table.tasks");
    var taskEmpty = taskSection === null ? null : taskSection.querySelector(".empty");
    var pages = [];
    var pageBody = null;
    var currentTable = null;

    function addPage() {
      var page = document.createElement("section");
      page.className = "preview-page";
      var body = document.createElement("div");
      body.className = "preview-page__body";
      page.appendChild(body);
      pagesRoot.appendChild(page);
      pages.push(page);
      pageBody = body;
      pageBodyRef.value = body;
      currentTable = null;
      currentTableRef.value = null;
      return body;
    }

    function overflows() {
      return pageBody.scrollHeight > pageBody.clientHeight + 1;
    }

    function appendFits(node) {
      pageBody.appendChild(node);
      if (!overflows()) {
        return true;
      }
      node.remove();
      return false;
    }

    function appendBlock(node) {
      var clone = node.cloneNode(true);
      if (appendFits(clone)) {
        return;
      }
      addPage();
      pageBody.appendChild(clone);
    }

    pageBody = addPage();
    topBlocks.forEach(appendBlock);

    function beginTaskTable() {
      var table = document.createElement("table");
      table.className = "tasks";
      var colgroup = taskTable.querySelector("colgroup");
      var thead = taskTable.querySelector("thead");
      if (colgroup !== null) {
        table.appendChild(colgroup.cloneNode(true));
      }
      if (thead !== null) {
        table.appendChild(thead.cloneNode(true));
      }
      pageBody.appendChild(table);
      currentTable = table;
      currentTableRef.value = table;
      return table;
    }

    function startGroupBody(group) {
      var tbody = document.createElement("tbody");
      tbody.className = group.className;
      currentTable.appendChild(tbody);
      return tbody;
    }

    if (taskTable !== null) {
      if (taskTitle !== null) {
        var titleClone = taskTitle.cloneNode(true);
        if (!appendFits(titleClone)) {
          addPage();
          titleClone = taskTitle.cloneNode(true);
          pageBody.appendChild(titleClone);
        }
      }

      beginTaskTable();
      Array.prototype.forEach.call(taskTable.querySelectorAll("tbody.grp"), function (group) {
        var rows = Array.prototype.slice.call(group.children);
        if (rows.length === 0) {
          return;
        }
        var groupHead = rows[0];
        var detailRows = rows.slice(1);
        var tbody = startGroupBody(group);
        var headClone = groupHead.cloneNode(true);
        tbody.appendChild(headClone);

        if (detailRows.length === 0) {
          if (overflows()) {
            headClone.remove();
            addPage();
            beginTaskTable();
            tbody = startGroupBody(group);
            tbody.appendChild(groupHead.cloneNode(true));
          }
        } else {
          var firstRow = detailRows[0].cloneNode(true);
          tbody.appendChild(firstRow);
          if (overflows()) {
            firstRow.remove();
            headClone.remove();
            addPage();
            beginTaskTable();
            tbody = startGroupBody(group);
            tbody.appendChild(groupHead.cloneNode(true));
            tbody.appendChild(detailRows[0].cloneNode(true));
          }
        }

        detailRows.slice(1).forEach(function (row) {
          var rowClone = row.cloneNode(true);
          tbody.appendChild(rowClone);
          if (!overflows()) {
            return;
          }
          rowClone.remove();
          addPage();
          beginTaskTable();
          tbody = startGroupBody(group);
          tbody.appendChild(groupHead.cloneNode(true));
          tbody.appendChild(row.cloneNode(true));
        });
      });
    } else if (taskEmpty !== null) {
      if (taskTitle !== null) {
        appendBlock(taskTitle);
      }
      appendBlock(taskEmpty);
    }

    pages.forEach(function (page, index) {
      var number = document.createElement("div");
      number.className = "preview-page__number";
      number.textContent = String(index + 1);
      page.appendChild(number);
    });
    return pages;
  }

  function render(parsed, resetScroll) {
    var token = ++renderToken;
    var source = Array.prototype.slice.call(parsed.body.children).filter(function (node) {
      return node.tagName !== "SCRIPT";
    }).map(function (node) {
      return node.cloneNode(true);
    });

    document.title = parsed.title;
    document.body.className = parsed.body.className;
    document.body.classList.add("preview-document");
    document.body.classList.remove("preview-ready");
    while (document.body.firstChild !== null) {
      document.body.removeChild(document.body.firstChild);
    }

    var pagesRoot = document.createElement("div");
    pagesRoot.className = "preview-pages";
    document.body.appendChild(pagesRoot);
    var pageBodyRef = { value: null };
    var currentTableRef = { value: null };
    var pages = buildPages(source, pagesRoot, pageBodyRef, currentTableRef);

    function finish() {
      if (token !== renderToken) {
        return;
      }
      pagesRoot.replaceChildren();
      pages = buildPages(source, pagesRoot, pageBodyRef, currentTableRef);
      latestPages = pages;
      document.body.classList.add("preview-ready");
      if (resetScroll) {
        window.scrollTo(0, 0);
      }
      window.setTimeout(function () {
        reportCurrentPage(pages);
      }, 0);
    }

    if (document.fonts !== undefined && document.fonts.ready !== undefined) {
      document.fonts.ready.then(finish, finish);
    } else {
      finish();
    }
  }

  function asDocument(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  window.addEventListener("scroll", function () {
    if (latestPages.length > 0) {
      reportCurrentPage(latestPages);
    }
  }, { passive: true });

  window.addEventListener("message", function (event) {
    if (event.source !== parent) {
      return;
    }
    var data = event.data;
    if (data === null || data === undefined || data.type !== "libiaolink:overview-preview-update" || typeof data.html !== "string") {
      return;
    }
    render(asDocument(data.html), true);
  });

  function boot() {
    if (booted) {
      return;
    }
    booted = true;
    render(asDocument("<!doctype html>" + document.documentElement.outerHTML), false);
  }

  window.setTimeout(boot, 3000);
  if (document.fonts !== undefined && document.fonts.ready !== undefined) {
    document.fonts.ready.then(boot, boot);
  } else {
    boot();
  }
})();
