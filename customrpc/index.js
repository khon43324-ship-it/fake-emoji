(function () {
  var metro = vendetta.metro;
  var storage = vendetta.plugin && vendetta.plugin.storage ? vendetta.plugin.storage : {};
  var common = metro.common || {};
  var cleanups = [];

  var SOCKET_ID = "CustomRPC";
  var TYPES = [
    { label: "Dang choi", value: 0 },
    { label: "Dang phat truc tiep", value: 1 },
    { label: "Dang nghe", value: 2 },
    { label: "Dang xem", value: 3 },
    { label: "Thi dau", value: 5 }
  ];
  var DEFAULTS = {
    enabled: true,
    appId: "",
    name: "My Game",
    type: 0,
    details: "",
    state: "",
    streamUrl: "",
    largeImage: "",
    largeText: "",
    smallImage: "",
    smallText: "",
    showTimer: true,
    button1Label: "",
    button1Url: "",
    button2Label: "",
    button2Url: ""
  };

  function log(m) { try { vendetta.logger.log("[RPC] " + m); } catch (e) {} }
  function toast(m) { try { vendetta.ui.toasts.showToast(m); } catch (e) {} }

  function getFlux() {
    return common.FluxDispatcher || metro.findByProps("dispatch", "subscribe");
  }

  // Doi anh thanh khoa asset: ho tro khoa tu app, link Discord CDN va link ngoai
  var assetCache = {};
  function resolveAsset(appId, value) {
    value = (value || "").trim();
    if (!value) return Promise.resolve(undefined);
    if (/^mp:/.test(value)) return Promise.resolve(value);
    if (!/^https?:\/\//i.test(value)) return Promise.resolve(value); // khoa asset da tai len app
    if (/^https?:\/\/(cdn|media)\.discordapp\.(com|net)\//i.test(value)) {
      return Promise.resolve("mp:" + value.replace(/^https?:\/\/(cdn|media)\.discordapp\.(com|net)\//i, ""));
    }
    if (assetCache[value]) return Promise.resolve(assetCache[value]);

    var Rest = metro.findByProps("getAPIBaseURL", "post");
    if (!Rest) return Promise.reject(new Error("khong co module API de doi anh"));
    return Rest.post({
      url: "/applications/" + (appId || "0") + "/external-assets",
      body: { urls: [value] }
    }).then(function (res) {
      var item = res && res.body && res.body[0];
      if (!item || !item.external_asset_path) throw new Error("khong doi duoc anh: " + value.slice(0, 40));
      assetCache[value] = "mp:" + item.external_asset_path;
      return assetCache[value];
    });
  }

  function buildActivity() {
    var s = storage;
    var appId = (s.appId || "").trim();
    var type = Number(s.type) || 0;

    return Promise.all([
      resolveAsset(appId, s.largeImage),
      resolveAsset(appId, s.smallImage)
    ]).then(function (imgs) {
      var activity = {
        application_id: appId || "0",
        name: s.name || "Custom RPC",
        type: type,
        flags: 1
      };
      if (s.details) activity.details = s.details;
      if (s.state) activity.state = s.state;
      if (type === 1 && s.streamUrl) activity.url = s.streamUrl;
      if (s.showTimer) activity.timestamps = { start: Date.now() };

      var assets = {};
      if (imgs[0]) { assets.large_image = imgs[0]; if (s.largeText) assets.large_text = s.largeText; }
      if (imgs[1]) { assets.small_image = imgs[1]; if (s.smallText) assets.small_text = s.smallText; }
      if (Object.keys(assets).length) activity.assets = assets;

      var labels = [], urls = [];
      [[s.button1Label, s.button1Url], [s.button2Label, s.button2Url]].forEach(function (b) {
        if (b[0] && b[1]) { labels.push(b[0]); urls.push(b[1]); }
      });
      if (labels.length) {
        activity.buttons = labels;
        activity.metadata = { button_urls: urls };
      }
      return activity;
    });
  }

  function countOurs(list) {
    try {
      if (!list) return "khong co";
      var arr = Array.isArray(list) ? list : (list.activities || []);
      var n = 0;
      arr.forEach(function (a) { if (a && (a.name === storage.name)) n++; });
      return n + "/" + arr.length;
    } catch (e) { return "?"; }
  }

  // Doc lai kho du lieu de biet Discord co nhan hoat dong khong
  function diagnose() {
    setTimeout(function () {
      var local = null, self = null;
      try { var L = metro.findByStoreName("LocalActivityStore"); local = L ? (L.getActivities ? L.getActivities() : []) : null; } catch (e) {}
      try { var S = metro.findByStoreName("SelfPresenceStore"); self = S ? (S.getActivities ? S.getActivities() : (S.getLocalPresence ? S.getLocalPresence() : [])) : null; } catch (e) {}
      var msg = "RPC kiem tra: LocalActivityStore=" + countOurs(local) + ", SelfPresence=" + countOurs(self);
      log(msg);
      toast(msg);
    }, 900);
  }

  function setActivity(activity) {
    var Flux = getFlux();
    if (!Flux) { toast("RPC LOI: khong tim thay FluxDispatcher"); return false; }
    Flux.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: activity, socketId: SOCKET_ID });
    return true;
  }

  function apply() {
    if (!storage.enabled) { clear(); toast("RPC: da tat"); return Promise.resolve(); }
    return buildActivity().then(function (act) {
      if (setActivity(act)) {
        toast("RPC: da dat \"" + act.name + "\"");
        diagnose();
      }
    }, function (e) {
      toast("RPC LOI: " + ((e && (e.message || e.status)) || e));
      log("apply loi: " + e);
    });
  }

  function clear() {
    try { setActivity(null); } catch (e) {}
  }

  // ===== Trang cai dat =====
  function Settings() {
    var React = common.React;
    var RN = common.ReactNative;
    var Forms = vendetta.ui && vendetta.ui.components && vendetta.ui.components.Forms;
    var useProxy = vendetta.storage && vendetta.storage.useProxy;
    if (useProxy) useProxy(storage);
    var h = React.createElement;

    if (!Forms || !Forms.FormInput || !Forms.FormRow) {
      return h(RN.Text, { style: { padding: 16 } },
        "Khong tim thay thanh phan giao dien cai dat. Hay sua gia tri mac dinh trong index.js.");
    }

    function input(key, title, placeholder) {
      return h(Forms.FormInput, {
        key: key, title: title, placeholder: placeholder || "", value: String(storage[key] == null ? "" : storage[key]),
        onChange: function (v) { storage[key] = v; }
      });
    }
    function typeLabel() {
      for (var i = 0; i < TYPES.length; i++) if (TYPES[i].value === Number(storage.type)) return TYPES[i].label;
      return "Dang choi";
    }
    function nextType() {
      var idx = 0;
      for (var i = 0; i < TYPES.length; i++) if (TYPES[i].value === Number(storage.type)) idx = i;
      storage.type = TYPES[(idx + 1) % TYPES.length].value;
    }

    var rows = [];
    if (Forms.FormSwitchRow) {
      rows.push(h(Forms.FormSwitchRow, {
        key: "enabled", label: "Bat Custom RPC", value: !!storage.enabled,
        onValueChange: function (v) { storage.enabled = v; }
      }));
      rows.push(h(Forms.FormSwitchRow, {
        key: "showTimer", label: "Hien thoi gian da troi qua", value: !!storage.showTimer,
        onValueChange: function (v) { storage.showTimer = v; }
      }));
    }
    rows.push(input("appId", "Application ID", "Lay tu Discord Developer Portal"));
    rows.push(input("name", "Ten hoat dong", "vd: Genshin Impact"));
    rows.push(h(Forms.FormRow, { key: "type", label: "Loai: " + typeLabel(), subLabel: "Bam de doi loai", onPress: function () { nextType(); } }));
    rows.push(input("streamUrl", "Link phat truc tiep (chi cho loai phat truc tiep)", "https://twitch.tv/..."));
    rows.push(input("details", "Chi tiet (dong 1)"));
    rows.push(input("state", "Trang thai (dong 2)"));
    rows.push(input("largeImage", "Anh lon (link hoac khoa asset)"));
    rows.push(input("largeText", "Chu khi re vao anh lon"));
    rows.push(input("smallImage", "Anh nho (link hoac khoa asset)"));
    rows.push(input("smallText", "Chu khi re vao anh nho"));
    rows.push(input("button1Label", "Nut 1: nhan"));
    rows.push(input("button1Url", "Nut 1: link", "https://..."));
    rows.push(input("button2Label", "Nut 2: nhan"));
    rows.push(input("button2Url", "Nut 2: link", "https://..."));
    rows.push(h(Forms.FormRow, { key: "apply", label: "Ap dung ngay", subLabel: "Luu va cap nhat trang thai", onPress: function () { apply(); } }));
    rows.push(h(Forms.FormRow, { key: "clear", label: "Xoa trang thai", onPress: function () { clear(); toast("RPC: da xoa"); } }));

    return h(RN.ScrollView, { style: { flex: 1 } },
      h(Forms.FormSection, { title: "Custom RPC", titleStyleType: "no_border" }, rows)
    );
  }

  return {
    onLoad: function () {
      Object.keys(DEFAULTS).forEach(function (k) { if (storage[k] === undefined) storage[k] = DEFAULTS[k]; });

      // Dat lai sau khi ket noi lai may chu
      try {
        var Flux = getFlux();
        if (Flux && Flux.subscribe) {
          var onOpen = function () { setTimeout(function () { if (storage.enabled) apply(); }, 1500); };
          Flux.subscribe("CONNECTION_OPEN", onOpen);
          cleanups.push(function () { Flux.unsubscribe("CONNECTION_OPEN", onOpen); });
        }
      } catch (e) { log("subscribe loi: " + e); }

      toast("Custom RPC da bat. Vao cai dat plugin de chinh, roi bam 'Ap dung ngay'");
      if (storage.enabled && storage.appId) apply();
    },
    onUnload: function () {
      clear();
      cleanups.forEach(function (c) { try { c(); } catch (e) {} });
      cleanups = [];
    },
    settings: Settings
  };
})()
