(function () {
  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var unpatches = [];

  // <:name:id> hoac <a:name:id>
  // ten emoji co the chua dau ~ (vd son~3)
  var EMOJI_RE = /<(a?):([\w~]{2,32}):(\d{17,20})>/g;

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

  // Dang giong Vencord: [ten](link)
  function toLink(animated, name, id) {
    return (
      "[" + name + "](https://cdn.discordapp.com/emojis/" + id + "." +
      (animated ? "gif" : "webp") + "?size=48&name=" + encName(name) + "&lossless=true)"
    );
  }

  // Doi emoji thanh link khi gui tin nhan
  function patchSend() {
    var MessageActions = metro.findByProps("sendMessage", "receiveMessage");
    if (!MessageActions) return false;

    var ChannelStore = metro.findByStoreName("ChannelStore");
    var EmojiStore = metro.findByStoreName("EmojiStore");

    unpatches.push(
      patcher.before("sendMessage", MessageActions, function (args) {
        var msg = args[1];
        if (!msg || typeof msg.content !== "string") return;

        var guildId = null;
        try {
          var ch = ChannelStore && ChannelStore.getChannel(args[0]);
          guildId = ch && ch.guild_id;
        } catch (e) {}

        msg.content = msg.content.replace(EMOJI_RE, function (full, a, name, id) {
          try {
            // Emoji cua chinh server dang chat thi de nguyen
            var emoji = EmojiStore && EmojiStore.getCustomEmojiById && EmojiStore.getCustomEmojiById(id);
            if (emoji && guildId && emoji.guildId === guildId) return full;
          } catch (e) {}
          return toLink(a === "a", name, id);
        });
      })
    );
    return true;
  }

  // Mo khoa viec chon emoji server khac trong ban phim emoji
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

  // Sticker -> link anh: [ten](link)
  function stickerLink(sticker) {
    var fmt = sticker.format_type != null ? sticker.format_type : sticker.formatType;
    if (fmt === 3) return null; // Lottie khong gui duoc bang link
    var name = String(sticker.name || "sticker").replace(/[\[\]]/g, "");
    return (
      "[" + name + "](https://media.discordapp.net/stickers/" + sticker.id + "." +
      (fmt === 4 ? "gif" : "png") + "?size=160&name=" + encName(name) + ")"
    );
  }

  // Khi gui sticker khong dung duoc, gui link anh thay the
  function patchStickers() {
    var Stickers = metro.findByProps("sendStickers");
    var MessageActions = metro.findByProps("sendMessage", "receiveMessage");
    var StickersStore = metro.findByStoreName("StickersStore");
    var ChannelStore = metro.findByStoreName("ChannelStore");
    if (!Stickers || !MessageActions || !StickersStore) return false;

    unpatches.push(
      patcher.instead("sendStickers", Stickers, function (args, orig) {
        try {
          var channelId = args[0];
          var ids = args[1];
          if (!Array.isArray(ids) || !ids.length) return orig.apply(Stickers, args);

          var ch = ChannelStore && ChannelStore.getChannel(channelId);
          var guildId = ch && ch.guild_id;
          var links = [];

          for (var i = 0; i < ids.length; i++) {
            var sid = ids[i] && typeof ids[i] === "object" ? ids[i].id : ids[i];
            var st = StickersStore.getStickerById(sid);
            if (!st) return orig.apply(Stickers, args);

            var gid = st.guild_id != null ? st.guild_id : st.guildId;
            // Sticker cua chinh server dang chat thi gui binh thuong
            if (guildId && gid === guildId) return orig.apply(Stickers, args);

            var link = stickerLink(st);
            if (!link) return orig.apply(Stickers, args);
            links.push(link);
          }

          return MessageActions.sendMessage(channelId, {
            content: links.join(" "),
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: []
          });
        } catch (e) {
          log("sendStickers loi: " + e);
          return orig.apply(Stickers, args);
        }
      })
    );
    return true;
  }

  return {
    onLoad: function () {
      var sendOk = false;
      var stickerOk = false;
      var perms = [];
      try { sendOk = patchSend(); } catch (e) { log("patchSend loi: " + e); }
      try { stickerOk = patchStickers(); } catch (e) { log("patchStickers loi: " + e); }
      try { perms = patchPermissions(); } catch (e) { log("patchPermissions loi: " + e); }

      var msg =
        "FakeEmoji - gui: " + (sendOk ? "OK" : "LOI") +
        ", sticker: " + (stickerOk ? "OK" : "LOI") +
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
