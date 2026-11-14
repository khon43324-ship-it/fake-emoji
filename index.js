(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];
  var seenKeys = {};

  // <:name:id> hoac <a:name:id>
  // ten emoji co the chua dau ~ (vd son~3)
  var EMOJI_RE = /<(a?):([\w~]{2,32}):(\d{17,20})>/g;
  var STICKER_FIELDS = ["sticker_ids", "stickerIds", "stickers"];

  function log(m) {
    try { vendetta.logger.log("[FakeEmoji] " + m); } catch (e) {}
  }
  function toast(m) {
    try { vendetta.ui.toasts.showToast(m); } catch (e) {}
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

  // Doi danh sach sticker thanh chuoi link.
  // Tra ve null neu phai de Discord gui binh thuong.
  function stickersToLinks(channelId, ids) {
    var StickersStore = metro.findByStoreName("StickersStore");
    var ChannelStore = metro.findByStoreName("ChannelStore");
    if (!StickersStore || !ids || !ids.length) return null;

    var ch = ChannelStore && ChannelStore.getChannel(channelId);
    var guildId = ch && ch.guild_id;
    var links = [];

    for (var i = 0; i < ids.length; i++) {
      var sid = ids[i] && typeof ids[i] === "object" ? ids[i].id : ids[i];
      var st = StickersStore.getStickerById(sid);
      if (!st) return null;

      var gid = st.guild_id != null ? st.guild_id : st.guildId;
      // Sticker cua chinh server dang chat thi gui binh thuong
      if (guildId && gid === guildId) return null;

      var link = stickerLink(st);
      if (!link) return null;
      links.push(link);
    }
    return links.join(" ");
  }

  // Lop 1: doi emoji (va sticker neu co trong tin nhan) khi gui tin nhan
  function patchSend() {
    var MessageActions = metro.findByProps("sendMessage", "receiveMessage");
    if (!MessageActions) return false;

    var ChannelStore = metro.findByStoreName("ChannelStore");
    var EmojiStore = metro.findByStoreName("EmojiStore");

    unpatches.push(
      patcher.before("sendMessage", MessageActions, function (args) {
        var channelId = args[0];
        var msg = args[1];
        if (!msg || typeof msg !== "object") return;

        // Sticker nam trong tin nhan hoac tham so phu
        try {
          for (var a = 1; a < args.length; a++) {
            var o = args[a];
            if (!o || typeof o !== "object") continue;
            for (var f = 0; f < STICKER_FIELDS.length; f++) {
              var key = STICKER_FIELDS[f];
              var ids = o[key];
              if (!Array.isArray(ids) || !ids.length) continue;
              if (!seenKeys[key]) {
                seenKeys[key] = true;
                toast("FakeEmoji: sendMessage co truong " + key);
              }
              var links = stickersToLinks(channelId, ids);
              if (links) {
                msg.content = (typeof msg.content === "string" && msg.content ? msg.content + " " : "") + links;
                o[key] = [];
              }
            }
          }
        } catch (e) { log("sticker trong sendMessage loi: " + e); }

        if (typeof msg.content !== "string") return;

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
      })
    );
    return true;
  }

  // Lop 2 + 3: chan sticker o ham gui rieng va o tang goi API (chac chan nhat)
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
              var links = ids && MessageActions ? stickersToLinks(channelId, ids) : null;
              if (!links) return orig.apply(m, args);
              return MessageActions.sendMessage(channelId, {
                content: links,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
              });
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
        patcher.before("post", Rest, function (args) {
          try {
            var req = args[0];
            if (!req || typeof req.url !== "string" || !req.body || typeof req.body !== "object") return;
            var m = /\/channels\/(\d+)\/messages$/.exec(req.url);
            if (!m) return;

            var body = req.body;
            for (var f = 0; f < STICKER_FIELDS.length; f++) {
              var key = STICKER_FIELDS[f];
              var ids = body[key];
              if (!Array.isArray(ids) || !ids.length) continue;
              var links = stickersToLinks(m[1], ids);
              if (!links) continue;
              body.content = (typeof body.content === "string" && body.content ? body.content + " " : "") + links;
              delete body[key];
            }
          } catch (e) { log("rest loi: " + e); }
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
        "FakeEmoji - gui: " + (sendOk ? "OK" : "LOI") +
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
