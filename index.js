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
    var keys = ["canUseEmojisEverywhere", "canUseAnimatedEmojis", "canUseCustomEmojisEverywhere"];
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
      var perms = [];
      try { sendOk = patchSend(); } catch (e) { log("patchSend loi: " + e); }
      try { perms = patchPermissions(); } catch (e) { log("patchPermissions loi: " + e); }

      var msg =
        "FakeEmoji - gui: " + (sendOk ? "OK" : "LOI") +
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
