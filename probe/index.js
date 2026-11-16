(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];
  var busy = false;

  // ===== Cai dat (sua tai day) =====
  var DEBUG = true;                 // hien thong bao chan doan
  var LIMIT = 10 * 1000 * 1000;     // gioi han Discord cho tai khoan khong Nitro (10.000.000 byte, da kiem chung bang file 10,10 MB)
  var PART = 9 * 1024 * 1024;       // moi phan toi da 9 MiB (thap hon gioi han de du cho)
  var DELAY = 1200;                 // nghi giua cac phan (ms) de tranh bi gioi han toc do
  var SPLIT_MEDIA = false;          // false: anh/video de Discord tu nen, khong chia
  // ==================================

  function log(m) { try { vendetta.logger.log("[Splitter] " + m); } catch (e) {} }
  function toast(m) { try { vendetta.ui.toasts.showToast(m); } catch (e) {} }
  function dbg(m) { log(m); if (DEBUG) toast("SPLIT " + m); }

  function alertBox(title, text) {
    try {
      vendetta.ui.alerts.showConfirmationAlert({
        title: title, content: text, confirmText: "Dong", onConfirm: function () {}, isDismissable: true
      });
    } catch (e) { toast(title + ": " + text); }
  }

  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
  function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Lay dung luong dong bo neu co the
  function syncSize(it) {
    var cands = [
      ["size", it && it.size],
      ["file.size", it && it.file && it.file.size],
      ["item.size", it && it.item && it.item.size],
      ["fileSize", it && it.fileSize]
    ];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i][1];
      if (typeof v === "number" && isFinite(v) && v > 0) return { size: v, via: cands[i][0] };
    }
    try {
      var S = metro.findByProps("getUploadFileSizeSum");
      if (S) {
        var s = S.getUploadFileSizeSum([it]);
        if (typeof s === "number" && isFinite(s) && s > 0) return { size: s, via: "getUploadFileSizeSum" };
      }
    } catch (e) {}
    return { size: null, via: "?" };
  }

  function getBlob(uri) {
    return fetch(uri).then(function (r) { return r.blob(); });
  }

  function isMedia(it) {
    var t = it && typeof it.mimeType === "string" ? it.mimeType : "";
    return /^(image|video)\//i.test(t);
  }

  // Tai mot phan len kho luu tru cua Discord roi tra ve thong tin tep da tai
  function uploadPart(Rest, channelId, filename, blob) {
    return Rest.post({
      url: "/channels/" + channelId + "/attachments",
      body: { files: [{ filename: filename, file_size: blob.size, id: "0" }] }
    }).then(function (res) {
      var att = res && res.body && res.body.attachments && res.body.attachments[0];
      if (!att || !att.upload_url) throw new Error("khong nhan duoc upload_url");
      return fetch(att.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob
      }).then(function (r) {
        if (!r.ok) throw new Error("PUT that bai: " + r.status);
        return att;
      });
    });
  }

  function sendPartMessage(Rest, channelId, att, filename, content, ref) {
    var body = {
      content: content,
      tts: false,
      flags: 0,
      attachments: [{ id: "0", filename: filename, uploaded_filename: att.upload_filename }]
    };
    if (ref) body.message_reference = ref;
    return Rest.post({ url: "/channels/" + channelId + "/messages", body: body });
  }

  // Chia mot file thanh cac phan va gui lan luot
  function splitAndSend(ctx, it, size) {
    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (!Rest) return Promise.reject(new Error("khong tim thay module API"));

    return getBlob(it.uri).then(function (blob) {
      var real = blob && blob.size ? blob.size : size;
      var total = Math.ceil(real / PART);
      var name = it.filename || "file";
      var idx = 0;

      function next() {
        if (idx >= total) return Promise.resolve();
        var n = idx++;
        var start = n * PART;
        var end = Math.min(start + PART, real);
        var part = blob.slice(start, end, "application/octet-stream");
        var partName = name + ".part" + pad(n + 1, 3);
        toast("Dang gui " + name + ": phan " + (n + 1) + "/" + total);

        return uploadPart(Rest, ctx.channelId, partName, part)
          .then(function (att) {
            var text = "";
            if (n === 0) {
              if (ctx.content) text += ctx.content + "\n";
              text += "`" + name + "` (" + mb(real) + ") chia " + total + " phan. Ghep lai: `cat " + name + ".part* > " + name + "`\n";
            }
            text += "phan " + (n + 1) + "/" + total;
            return sendPartMessage(Rest, ctx.channelId, att, partName, text, n === 0 ? ctx.ref : null);
          })
          .then(function () { return n + 1 < total ? delay(DELAY) : null; })
          .then(next);
      }
      return next();
    });
  }

  // Don dep tin nhan tam va khay dinh kem sau khi da chan gui
  function cleanup(opts) {
    try {
      var Flux = metro.findByProps("dispatch", "subscribe");
      if (Flux && opts.nonce) Flux.dispatch({ type: "MESSAGE_DELETE", channelId: opts.channelId, id: opts.nonce });
    } catch (e) { log("xoa tin tam loi: " + e); }
    try {
      var U = metro.findByProps("setUploads");
      if (U) U.setUploads({ channelId: opts.channelId, uploads: [], draftType: opts.draftType != null ? opts.draftType : 0, resetState: true });
    } catch (e) { log("don khay loi: " + e); }
  }

  function patchUpload() {
    var mod = metro.findByProps("uploadMessageAttachments");
    if (!mod || typeof mod.uploadMessageAttachments !== "function") return false;

    unpatches.push(
      patcher.instead("uploadMessageAttachments", mod, function (args, orig) {
        try {
          var opts = args[0];
          var items = opts && Array.isArray(opts.items) ? opts.items : null;
          if (!items || !items.length || busy) return orig.apply(mod, args);

          var sizes = items.map(syncSize);
          var anyUnknown = false, anyBig = false;
          for (var i = 0; i < items.length; i++) {
            if (isMedia(items[i]) && !SPLIT_MEDIA) continue;
            if (sizes[i].size == null) anyUnknown = true;
            else if (sizes[i].size > LIMIT) anyBig = true;
          }
          // File nho: de Discord xu ly nhu binh thuong, khong cham gi
          if (!anyUnknown && !anyBig) return orig.apply(mod, args);

          // Do dung luong cac file chua biet (doc qua fetch)
          return Promise.all(items.map(function (it, i) {
            if (sizes[i].size != null) return sizes[i].size;
            if (isMedia(it) && !SPLIT_MEDIA) return 0;
            return getBlob(it.uri).then(function (b) { sizes[i].via = "blob"; return b && b.size ? b.size : 0; }, function () { return 0; });
          })).then(function (real) {
            var bigs = [], smalls = [];
            items.forEach(function (it, i) {
              var skip = isMedia(it) && !SPLIT_MEDIA;
              if (!skip && real[i] > LIMIT) bigs.push({ it: it, size: real[i], via: sizes[i].via });
              else smalls.push(it);
            });
            if (!bigs.length) return orig.apply(mod, args);

            dbg(bigs.map(function (b) { return (b.it.filename || "?") + " " + mb(b.size) + " (qua " + b.via + ")"; }).join(", "));

            var msg = opts.message || {};
            var ref = null;
            try {
              var mr = msg.messageReference || msg.message_reference;
              if (mr && (mr.message_id || mr.messageId)) {
                ref = { message_id: mr.message_id || mr.messageId, channel_id: mr.channel_id || mr.channelId || opts.channelId };
              }
            } catch (e) {}
            var ctx = { channelId: opts.channelId, content: typeof msg.content === "string" ? msg.content : "", ref: ref };

            // File nho trong cung lan gui van di theo duong cu
            if (smalls.length) {
              var a2 = Array.prototype.slice.call(args);
              a2[0] = Object.assign({}, opts, { items: smalls });
              orig.apply(mod, a2);
            } else {
              cleanup(opts);
            }

            busy = true;
            var chain = Promise.resolve();
            bigs.forEach(function (b, k) {
              chain = chain.then(function () {
                // Chi phan dau cua file dau tien mang theo noi dung go san
                if (k > 0) { ctx.content = ""; ctx.ref = null; }
                return splitAndSend(ctx, b.it, b.size);
              });
            });
            return chain.then(function () {
              busy = false;
              toast("Da gui xong " + bigs.length + " file");
            }, function (e) {
              busy = false;
              alertBox("Large File Splitter - LOI", String((e && (e.message || e.status)) || e) + (e && e.body ? "\n" + JSON.stringify(e.body).slice(0, 300) : ""));
            });
          });
        } catch (e) {
          busy = false;
          log("loi: " + e);
          return orig.apply(mod, args);
        }
      })
    );
    return true;
  }

  return {
    onLoad: function () {
      var ok = false;
      try { ok = patchUpload(); } catch (e) { log("patchUpload loi: " + e); }
      toast("Large File Splitter - " + (ok ? "OK (chia file > " + mb(LIMIT) + ")" : "LOI: khong tim thay uploadMessageAttachments"));
    },
    onUnload: function () {
      unpatches.forEach(function (u) { try { u(); } catch (e) {} });
      unpatches = [];
    }
  };
})()
