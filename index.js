(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];

  // Bat thong bao chan doan (DBG ...). Dat false khi da chay on.
  var DEBUG = false;

  // <:name:id> hoac <a:name:id>
  // ten emoji co the chua dau ~ (vd son~3)
  var EMOJI_RE = /<(a?):([\w~]{2,32}):(\d{17,20})>/g;

  function log(m) {
    try { vendetta.logger.log("[FakeEmoji] " + m); } catch (e) {}
  }
  function toast(m) {
    try { vendetta.ui.toasts.showToast(m); } catch (e) {}
  }
  function dbg(m) {
    log("DBG " + m);
    if (DEBUG) toast("DBG " + m);
  }

  // Mo ta ngan gon mot gia tri de hien trong thong bao
  function desc(v) {
    try {
      if (Array.isArray(v)) return "mang(" + v.length + ")" + (v.length ? ":" + desc(v[0]) : "");
      if (v && typeof v === "object") return "obj{" + Object.keys(v).slice(0, 6).join(",") + "}";
      return typeof v + (typeof v === "string" || typeof v === "number" ? "=" + String(v).slice(0, 20) : "");
    } catch (e) { return "?"; }
  }

  // Ma hoa giong URLSearchParams (~ -> %7E)
  function encName(name) {
    return encodeURIComponent(name).replace(/[!'()*~]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  // Emoji -> [ten](link), giong Vencord
  function toLink(animated, name, id) {
    return (
      "[" + name + "](https://cdn.discordapp.com/emojis/" + id + "." +
      (animated ? "gif" : "webp") + "?size=48&name=" + encName(name) + "&lossless=true)"
    );
  }

  // Sticker -> [ten](link)
  function stickerLink(sticker) {
    var fmt = sticker.format_type != null ? sticker.format_type : sticker.formatType;
    if (fmt === 3) return null; // Lottie khong gui duoc bang link
    var name = String(sticker.name || "sticker").replace(/[\[\]]/g, "");
    return (
      "[" + name + "](https://media.discordapp.net/stickers/" + sticker.id + "." +
      (fmt === 4 ? "gif" : "png") + "?size=160&name=" + encName(name) + ")"
    );
  }

  // Link du phong khi khong tra duoc thong tin sticker (chi biet id)
  function fallbackStickerLink(id) {
    return "[sticker](https://media.discordapp.net/stickers/" + id + ".png?size=160&name=sticker)";
  }

  // Gui mot tin nhan chua link. Uu tien goi thang API (khong phu thuoc tham so cua sendMessage)
  // va bao ket qua tu may chu.
  function sendLinkMessage(channelId, content) {
    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (Rest && typeof Rest.post === "function") {
      try {
        var p = Rest.post({
          url: "/channels/" + channelId + "/messages",
          body: { content: content, tts: false }
        });
        if (p && typeof p.then === "function") {
          p.then(
            function (r) { dbg("gui link qua REST: OK " + (r && r.status != null ? r.status : "")); },
            function (e) {
              var detail = "";
              try {
                detail = (e && (e.status || e.message)) || "?";
                if (e && e.body && (e.body.message || e.body.code)) detail += " " + (e.body.message || e.body.code);
              } catch (x) {}
              dbg("gui link qua REST: LOI " + detail);
            }
          );
        }
        return p;
      } catch (e) {
        log("sendLinkMessage REST loi: " + e);
      }
    }
    var MA = metro.findByProps("sendMessage", "receiveMessage");
    if (!MA) return;
    dbg("khong co REST, dung sendMessage");
    return MA.sendMessage(channelId, {
      content: content,
      tts: false,
      invalidEmojis: [],
      validNonShortcutEmojis: []
    });
  }

  // Cac truong nao cua mot doi tuong chua danh sach sticker
  function findStickerKeys(o) {
    var keys = [];
    if (!o || typeof o !== "object") return keys;
    try {
      Object.keys(o).forEach(function (k) {
        if (/sticker/i.test(k) && Array.isArray(o[k]) && o[k].length) keys.push(k);
      });
    } catch (e) {}
    return keys;
  }

  // Doi danh sach sticker thanh chuoi link.
  // Tra ve { links: chuoi | null, why: ly do }. links = null nghia la de Discord gui binh thuong.
  function stickersToLinks(channelId, ids) {
    if (!ids || !ids.length) return { links: null, why: "rong" };

    var StickersStore = metro.findByStoreName("StickersStore");
    var ChannelStore = metro.findByStoreName("ChannelStore");

    var ch = null;
    try { ch = ChannelStore && ChannelStore.getChannel(channelId); } catch (e) {}
    var guildId = ch && ch.guild_id;
    var links = [];
    var notes = [];

    for (var i = 0; i < ids.length; i++) {
      var sid = ids[i] && typeof ids[i] === "object" ? ids[i].id : ids[i];
      var st = null;
      try {
        st = StickersStore && StickersStore.getStickerById ? StickersStore.getStickerById(sid) : null;
      } catch (e) {}

      if (!st) {
        notes.push(StickersStore ? "khong thay id" : "khong co store");
        links.push(fallbackStickerLink(sid));
        continue;
      }

      var gid = st.guild_id != null ? st.guild_id : st.guildId;
      // Sticker cua chinh server dang chat thi gui binh thuong
      if (guildId && gid === guildId) return { links: null, why: "sticker cua server hien tai" };

      var link = stickerLink(st);
      if (!link) return { links: null, why: "sticker Lottie" };
      notes.push("fmt=" + (st.format_type != null ? st.format_type : st.formatType));
      links.push(link);
    }
    return { links: links.join(" "), why: notes.join(",") || "ok" };
  }

  // Doi emoji trong noi dung (sua tai cho, nhu cac ban truoc da chay duoc)
  function replaceEmojis(channelId, msg) {
    if (!msg || typeof msg.content !== "string") return;

    var ChannelStore = metro.findByStoreName("ChannelStore");
    var EmojiStore = metro.findByStoreName("EmojiStore");
    var guildId = null;
    try {
      var ch = ChannelStore && ChannelStore.getChannel(channelId);
      guildId = ch && ch.guild_id;
    } catch (e) {}

    msg.content = msg.content.replace(EMOJI_RE, function (full, an, name, id) {
      try {
        // Emoji cua chinh server dang chat thi de nguyen
        var emoji = EmojiStore && EmojiStore.getCustomEmojiById && EmojiStore.getCustomEmojiById(id);
        if (emoji && guildId && emoji.guildId === guildId) return full;
      } catch (e) {}
      return toLink(an === "a", name, id);
    });
  }

  // Lop 1: chan sendMessage. Sticker thi tao BAN SAO tham so roi moi gui (tranh doi tuong bi khoa).
  function patchSend() {
    var MessageActions = metro.findByProps("sendMessage", "receiveMessage");
    if (!MessageActions) return false;

    unpatches.push(
      patcher.instead("sendMessage", MessageActions, function (args, orig) {
        var newArgs = args;
        try {
          var channelId = args[0];
          var extraLinks = [];
          var report = [];

          newArgs = Array.prototype.slice.call(args);
          for (var a = 1; a < newArgs.length; a++) {
            var o = newArgs[a];
            var keys = findStickerKeys(o);
            if (!keys.length) continue;

            var copy = Object.assign({}, o);
            for (var k = 0; k < keys.length; k++) {
              var key = keys[k];
              var res = stickersToLinks(channelId, o[key]);
              report.push("arg" + a + "." + key + "=" + desc(o[key]) + " -> " + (res.links ? "LINK" : "giu") + " (" + res.why + ")");
              if (res.links) {
                extraLinks.push(res.links);
                copy[key] = [];
              }
            }
            newArgs[a] = copy;
          }

          if (report.length) dbg("sendMessage: " + report.join(" ; "));

          if (extraLinks.length) {
            var base = newArgs[1] && typeof newArgs[1] === "object" ? newArgs[1] : {};
            var msg = Object.assign({}, base);
            var old = typeof msg.content === "string" ? msg.content : "";
            msg.content = (old ? old + " " : "") + extraLinks.join(" ");
            newArgs[1] = msg;
          }

          if (newArgs[1] && typeof newArgs[1] === "object") {
            // Neu doi tuong bi khoa thi sua tai cho se bi bo qua, nen tao ban sao
            var m = newArgs[1];
            if (typeof m.content === "string" && EMOJI_RE.test(m.content)) {
              EMOJI_RE.lastIndex = 0;
              if (Object.isFrozen(m) || Object.isSealed(m)) {
                m = Object.assign({}, m);
                newArgs[1] = m;
              }
              replaceEmojis(channelId, m);
            }
            EMOJI_RE.lastIndex = 0;
          }
        } catch (e) {
          log("sendMessage loi: " + e);
          newArgs = args;
        }
        return orig.apply(MessageActions, newArgs);
      })
    );
    return true;
  }

  // Lop 2 + 3: chan sticker o ham gui rieng va o tang goi API
  function patchStickers() {
    var layers = [];
    var MessageActions = metro.findByProps("sendMessage", "receiveMessage");

    // Cac ham gui sticker rieng, vd sendStickers
    var seenModules = [];
    var modules = [metro.findByProps("sendStickers"), MessageActions];
    modules.forEach(function (m) {
      if (!m || seenModules.indexOf(m) !== -1) return;
      seenModules.push(m);
      Object.keys(m).forEach(function (k) {
        if (!/^sendSticker/i.test(k) || typeof m[k] !== "function") return;
        unpatches.push(
          patcher.instead(k, m, function (args, orig) {
            try {
              var channelId = args[0];
              var ids = null;
              for (var i = 1; i < args.length; i++) {
                if (Array.isArray(args[i])) { ids = args[i]; break; }
              }
              var res = ids && MessageActions ? stickersToLinks(channelId, ids) : { links: null, why: "khong co mang id" };
              dbg(k + ": " + args.map(desc).join(" | ") + " -> " + (res.links ? "LINK" : "giu") + " (" + res.why + ")");
              if (!res.links) return orig.apply(m, args);
              // Tham so thu 3 (neu la chuoi) la chu nguoi dung go kem sticker
              var typed = typeof args[2] === "string" && args[2] ? args[2] + " " : "";
              return sendLinkMessage(channelId, typed + res.links);
            } catch (e) {
              log(k + " loi: " + e);
              return orig.apply(m, args);
            }
          })
        );
        layers.push(k);
      });
    });

    // Tang goi API: sua noi dung yeu cau gui tin nhan truoc khi len may chu
    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (Rest && typeof Rest.post === "function") {
      unpatches.push(
        patcher.instead("post", Rest, function (args, orig) {
          var newArgs = args;
          try {
            var req = args[0];
            var m = req && typeof req.url === "string" && req.body && typeof req.body === "object"
              ? /\/channels\/(\d+)\/messages$/.exec(req.url) : null;
            if (m) {
              var keys = findStickerKeys(req.body);
              if (keys.length) {
                // Luon tao ban sao de khong phu thuoc vao doi tuong co bi khoa hay khong
                var nb = Object.assign({}, req.body);
                var changed = false;
                for (var f = 0; f < keys.length; f++) {
                  var key = keys[f];
                  var res = stickersToLinks(m[1], req.body[key]);
                  dbg("rest " + key + "=" + desc(req.body[key]) + " -> " + (res.links ? "LINK" : "giu") + " (" + res.why + ")");
                  if (!res.links) continue;
                  var old = typeof nb.content === "string" ? nb.content : "";
                  nb.content = (old ? old + " " : "") + res.links;
                  delete nb[key];
                  changed = true;
                }
                if (changed) {
                  newArgs = Array.prototype.slice.call(args);
                  newArgs[0] = Object.assign({}, req, { body: nb });
                }
              }
            }
          } catch (e) { log("rest loi: " + e); newArgs = args; }
          return orig.apply(Rest, newArgs);
        })
      );
      layers.push("rest");
    }
    return layers;
  }

  // Mo khoa viec chon emoji/sticker server khac trong ban phim
  function patchPermissions() {
    var keys = [
      "canUseEmojisEverywhere", "canUseAnimatedEmojis", "canUseCustomEmojisEverywhere",
      "canUseStickersEverywhere", "canUseCustomStickersEverywhere", "isSendableSticker"
    ];
    var patched = [];
    keys.forEach(function (k) {
      var m = metro.findByProps(k);
      if (m && typeof m[k] === "function") {
        unpatches.push(
          patcher.instead(k, m, function () { return true; })
        );
        patched.push(k);
      }
    });
    return patched;
  }

  return {
    onLoad: function () {
      var sendOk = false;
      var layers = [];
      var perms = [];
      try { sendOk = patchSend(); } catch (e) { log("patchSend loi: " + e); }
      try { layers = patchStickers(); } catch (e) { log("patchStickers loi: " + e); }
      try { perms = patchPermissions(); } catch (e) { log("patchPermissions loi: " + e); }

      var msg =
        "FakeEmoji v7 - gui: " + (sendOk ? "OK" : "LOI") +
        ", sticker: " + (layers.length ? layers.join("+") : "khong tim thay") +
        ", mo khoa: " + (perms.length ? perms.join(", ") : "khong tim thay");
      log(msg);
      toast(msg);
    },
    onUnload: function () {
      unpatches.forEach(function (u) { try { u(); } catch (e) {} });
      unpatches = [];
    }
  };
})()
