(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];
  var events = [];
  var timer = null;
  var lastShown = 0;
  var NAME_RE = /upload|addfile/i;
  var MAX_PATCHES = 40;
  var MAX_CHARS = 2400;

  function log(m) { try { vendetta.logger.log("[Probe2] " + m); } catch (e) {} }
  function toast(m) { try { vendetta.ui.toasts.showToast(m); } catch (e) {} }

  // Mo ta cau truc mot gia tri thanh nhieu dong co thut le
  function dump(v, depth, ind) {
    try {
      if (v == null) return String(v);
      var t = typeof v;
      if (t === "string") return JSON.stringify(v.length > 70 ? v.slice(0, 70) + "..(" + v.length + ")" : v);
      if (t === "number" || t === "boolean") return String(v);
      if (t === "function") return "fn";
      if (Array.isArray(v)) {
        if (!v.length) return "[]";
        if (depth >= 4) return "[" + v.length + "]";
        return "[" + v.length + "]\n" + ind + "  0: " + dump(v[0], depth + 1, ind + "  ");
      }
      if (t === "object") {
        var keys = Object.keys(v);
        if (!keys.length) return "{}";
        if (depth >= 4) return "{" + keys.slice(0, 10).join(",") + "}";
        var lines = keys.slice(0, 14).map(function (k) {
          var val;
          try { val = v[k]; } catch (e) { val = "(loi doc)"; }
          return ind + "  " + k + ": " + dump(val, depth + 1, ind + "  ");
        });
        if (keys.length > 14) lines.push(ind + "  ... +" + (keys.length - 14) + " truong");
        return "\n" + lines.join("\n");
      }
      return t;
    } catch (e) { return "?"; }
  }

  function showReport() {
    timer = null;
    var text = events.join("\n------\n");
    events = [];
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n...(cat bot)";
    log(text);
    lastShown = Date.now();
    try {
      vendetta.ui.alerts.showConfirmationAlert({
        title: "UPLOAD PROBE - chup man hinh nay",
        content: text,
        confirmText: "Dong",
        onConfirm: function () {},
        isDismissable: true
      });
    } catch (e) {
      toast("PROBE: khong mo duoc hop thoai: " + e);
    }
  }

  function record(name, args) {
    // Hop thoai chi hien lai sau it nhat 5 giay
    if (Date.now() - lastShown < 5000 && !timer && events.length === 0) return;
    var parts = Array.prototype.map.call(args, function (a, i) {
      return "arg" + i + ": " + dump(a, name === "uploadMessageAttachments" ? 0 : 2, "");
    });
    events.push(name + "\n" + parts.join("\n"));
    if (!timer) timer = setTimeout(showReport, 1500);
  }

  function findCandidates() {
    var found = [];
    var mods = [];
    try {
      if (typeof metro.findAll === "function") {
        mods = metro.findAll(function (m) { return m && (typeof m === "object" || typeof m === "function"); }) || [];
      }
    } catch (e) { log("findAll loi: " + e); }
    if (!mods.length) {
      ["uploadMessageAttachments", "uploadFiles", "addFiles", "upload"].forEach(function (k) {
        try { var m = metro.findByProps(k); if (m) mods.push(m); } catch (e) {}
      });
    }
    var seen = [];
    mods.forEach(function (m) {
      try {
        if (seen.indexOf(m) !== -1) return;
        seen.push(m);
        Object.keys(m).forEach(function (k) {
          var fn;
          try { fn = m[k]; } catch (e) { return; }
          if (typeof fn === "function" && NAME_RE.test(k)) found.push({ mod: m, name: k });
        });
      } catch (e) {}
    });
    return found;
  }

  function patchAll() {
    var cands = findCandidates();
    var names = [];
    for (var i = 0; i < cands.length && names.length < MAX_PATCHES; i++) {
      (function (c) {
        try {
          unpatches.push(patcher.before(c.name, c.mod, function (args) { record(c.name, args); }));
          names.push(c.name);
        } catch (e) {}
      })(cands[i]);
    }
    return names;
  }

  // Bao loi tu may chu khi gui tin nhan / tai file
  function patchRest() {
    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (!Rest || typeof Rest.post !== "function") return false;
    unpatches.push(
      patcher.instead("post", Rest, function (args, orig) {
        var p = orig.apply(Rest, args);
        try {
          var url = args[0] && args[0].url;
          if (typeof url === "string" && /messages|attachments/.test(url) && p && typeof p.then === "function") {
            p.then(null, function (e) {
              var detail = (e && (e.status || e.message)) || "?";
              try { if (e && e.body) detail += " " + JSON.stringify(e.body).slice(0, 200); } catch (x) {}
              events.push("REST LOI " + url.slice(0, 60) + "\n" + detail);
              if (!timer) timer = setTimeout(showReport, 800);
            });
          }
        } catch (e) {}
        return p;
      })
    );
    return true;
  }

  return {
    onLoad: function () {
      var names = [];
      var restOk = false;
      try { names = patchAll(); } catch (e) { log("patchAll loi: " + e); }
      try { restOk = patchRest(); } catch (e) { log("patchRest loi: " + e); }
      var uniq = names.filter(function (n, i, a) { return a.indexOf(n) === i; });
      toast("PROBE2: " + uniq.length + " ham, rest " + (restOk ? "OK" : "khong co"));
      log("ham: " + uniq.join(", "));

      // Hien danh sach ten ham trong mot hop thoai de chup man hinh
      setTimeout(function () {
        try {
          var text = uniq.length ? uniq.join(", ") : "(khong tim thay ham nao)";
          if (text.length > 1800) text = text.slice(0, 1800) + "...";
          vendetta.ui.alerts.showConfirmationAlert({
            title: "PROBE2 - danh sach ham (chup man hinh)",
            content: text,
            confirmText: "Dong",
            onConfirm: function () {},
            isDismissable: true
          });
        } catch (e) { toast("PROBE2: khong mo duoc hop thoai: " + e); }
      }, 2500);
    },
    onUnload: function () {
      if (timer) { clearTimeout(timer); timer = null; }
      unpatches.forEach(function (u) { try { u(); } catch (e) {} });
      unpatches = [];
      events = [];
    }
  };
})()
