(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];
  var counts = {};
  var MAX_PATCHES = 40;
  var MAX_PER_FN = 3; // moi ham chi bao toi da 3 lan
  var NAME_RE = /upload|addfile/i;

  function log(m) { try { vendetta.logger.log("[Probe] " + m); } catch (e) {} }
  function toast(m) { try { vendetta.ui.toasts.showToast(m); } catch (e) {} }

  // Mo ta ngan gon mot gia tri, chu y cac truong lien quan den file
  function brief(v, depth) {
    try {
      depth = depth || 0;
      if (v == null) return String(v);
      if (depth > 3 && typeof v === "object") return "..";
      var t = typeof v;
      if (t === "string") {
        return /^(file|content|ph|assets-library):/i.test(v) ? "uri:" + v.slice(0, 36) : "str(" + v.length + ")";
      }
      if (t === "number" || t === "boolean") return String(v);
      if (t === "function") return "fn";
      if (Array.isArray(v)) return "[" + v.length + (v.length ? " " + brief(v[0], depth + 1) : "") + "]";
      if (t === "object") {
        var keys = Object.keys(v).slice(0, 8);
        var hints = keys
          .filter(function (k) { return /size|name|uri|path|mime|type|length|channel|file|item|upload|attach/i.test(k); })
          .map(function (k) { return k + "=" + brief(v[k], depth + 1); });
        return "{" + keys.join(",") + (hints.length ? " | " + hints.join(" ") : "") + "}";
      }
      return t;
    } catch (e) { return "?"; }
  }

  function report(name, args) {
    counts[name] = (counts[name] || 0) + 1;
    if (counts[name] > MAX_PER_FN) return;
    var msg = "PROBE " + name + "(" + Array.prototype.map.call(args, function (a) { return brief(a, 0); }).join(" | ") + ")";
    log(msg);
    toast(msg);
  }

  // Tim cac module co ham ten giong upload
  function findCandidates() {
    var found = [];
    var mods = [];
    try {
      if (typeof metro.findAll === "function") {
        mods = metro.findAll(function (m) { return m && (typeof m === "object" || typeof m === "function"); }) || [];
      }
    } catch (e) { log("findAll loi: " + e); }

    // Du phong neu khong co findAll
    if (!mods.length) {
      ["uploadFiles", "addFiles", "upload", "uploadFile", "CloudUpload", "UploadManager"].forEach(function (k) {
        try { var m = metro.findByProps(k); if (m) mods.push(m); } catch (e) {}
      });
    }

    var seenMods = [];
    mods.forEach(function (m) {
      try {
        if (seenMods.indexOf(m) !== -1) return;
        seenMods.push(m);
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
    var patched = [];
    for (var i = 0; i < cands.length && patched.length < MAX_PATCHES; i++) {
      (function (c) {
        try {
          unpatches.push(patcher.before(c.name, c.mod, function (args) { report(c.name, args); }));
          patched.push(c.name);
        } catch (e) {}
      })(cands[i]);
    }
    return { patched: patched, total: cands.length };
  }

  // Bao loi khi gui tin nhan len API (vd 413 / ma 40005: file qua lon)
  function patchRest() {
    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (!Rest || typeof Rest.post !== "function") return false;
    unpatches.push(
      patcher.instead("post", Rest, function (args, orig) {
        var p = orig.apply(Rest, args);
        try {
          var url = args[0] && args[0].url;
          if (typeof url === "string" && /\/messages|attachments/.test(url) && p && typeof p.then === "function") {
            p.then(null, function (e) {
              var detail = (e && (e.status || e.message)) || "?";
              try { if (e && e.body && (e.body.code || e.body.message)) detail += " code=" + e.body.code + " " + e.body.message; } catch (x) {}
              var msg = "PROBE REST LOI " + url.slice(0, 40) + " -> " + detail;
              log(msg); toast(msg);
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
      var r = { patched: [], total: 0 };
      var restOk = false;
      try { r = patchAll(); } catch (e) { log("patchAll loi: " + e); }
      try { restOk = patchRest(); } catch (e) { log("patchRest loi: " + e); }

      var uniq = r.patched.filter(function (n, i, a) { return a.indexOf(n) === i; });
      toast("PROBE: " + uniq.length + " ham upload da gan" + (restOk ? ", rest OK" : ", rest khong co"));
      if (uniq.length) toast("PROBE ham: " + uniq.slice(0, 12).join(", "));
      log("ham: " + uniq.join(", "));
    },
    onUnload: function () {
      unpatches.forEach(function (u) { try { u(); } catch (e) {} });
      unpatches = [];
    }
  };
})()
