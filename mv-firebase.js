/* Media Vault // Firebase bridge (stage 1: sign-in, usernames, personal vault).
   Loads the Firebase web SDK from Google's CDN and exposes window.MV for the app. */
(async function () {
  var VER = "10.14.1";
  var BASE = "https://www.gstatic.com/firebasejs/" + VER + "/";
  var CONFIG = {
    apiKey: "AIzaSyDxOF5dob5EGjcI-kWWTc5PI1_zfUVAUAs",
    authDomain: "media-vault-scanner.firebaseapp.com",
    projectId: "media-vault-scanner",
    storageBucket: "media-vault-scanner.firebasestorage.app",
    messagingSenderId: "399739818861",
    appId: "1:399739818861:web:19ec9bc9640c84ec6e0064"
  };
  var KEYS = ["kind", "format", "title", "artist", "year", "upc", "label", "cat", "room", "tags",
    "manual", "first", "firstNew", "foundAt", "foundId", "gv", "crew", "addedAt", "coverUrl"];

  try {
    var mods = await Promise.all([
      import(BASE + "firebase-app.js"),
      import(BASE + "firebase-auth.js"),
      import(BASE + "firebase-firestore.js")
    ]);
    var A = mods[0], Au = mods[1], F = mods[2];
    var app = A.initializeApp(CONFIG);
    var auth = Au.getAuth(app);
    var db = F.getFirestore(app);
    var last = {};   // vault doc id -> signature of what is stored
    var queue = Promise.resolve();

    function hash36(s) { var h = 7; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); }
    function docId(a) {
      var u = String(a.upc || "").replace(/[^0-9A-Za-z]/g, "");
      return u ? "u" + u : "t" + hash36((String(a.title) + "|" + String(a.artist || "")).toLowerCase());
    }
    function toDoc(a) {
      var o = {};
      KEYS.forEach(function (k) {
        var v = a[k];
        if (v === undefined || v === null || v === "") return;
        if (typeof v === "number" && !isFinite(v)) return;
        o[k] = v;
      });
      return o;
    }
    function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
    function userDoc(uid) { return F.doc(db, "users", uid); }
    function vaultCol(uid) { return F.collection(db, "users", uid, "vault"); }

    var MV = {
      ready: true,
      user: function () { var u = auth.currentUser; return u ? { uid: u.uid, email: u.email || "" } : null; },
      onAuth: function (cb) { return Au.onAuthStateChanged(auth, cb); },

      google: async function () {
        var p = new Au.GoogleAuthProvider();
        try { await Au.signInWithPopup(auth, p); }
        catch (e) {
          if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) {
            await Au.signInWithRedirect(auth, p); return;
          }
          throw e;
        }
      },
      sendLink: async function (email) {
        await Au.sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname, handleCodeInApp: true });
        try { localStorage.setItem("mv-email", email); } catch (e) {}
      },
      isLink: function () { return Au.isSignInWithEmailLink(auth, location.href); },
      savedEmail: function () { try { return localStorage.getItem("mv-email") || ""; } catch (e) { return ""; } },
      completeLink: async function (email) {
        await Au.signInWithEmailLink(auth, email, location.href);
        try { localStorage.removeItem("mv-email"); } catch (e) {}
        try { history.replaceState(null, "", location.pathname); } catch (e) {}
      },
      signOut: function () { last = {}; return Au.signOut(auth); },

      profile: async function (uid) {
        var s = await F.getDoc(userDoc(uid));
        return s.exists() ? (s.data().username || null) : null;
      },
      claim: async function (name) {
        var u = auth.currentUser; if (!u) throw { code: "no-user" };
        var taken = await F.getDoc(F.doc(db, "usernames", name));
        if (taken.exists()) {
          if ((taken.data() || {}).uid === u.uid) {   // this name is already yours: restore your profile instead of refusing
            await F.setDoc(userDoc(u.uid), { username: name, createdAt: F.serverTimestamp() });
            return;
          }
          throw { code: "taken" };
        }
        var b = F.writeBatch(db);
        b.set(F.doc(db, "usernames", name), { uid: u.uid, createdAt: F.serverTimestamp() });
        b.set(userDoc(u.uid), { username: name, createdAt: F.serverTimestamp() });
        try { await b.commit(); }
        catch (e) { if (e && e.code === "permission-denied") throw { code: "taken" }; throw e; }
      },

      loadVault: async function (uid) {
        var snap = await F.getDocs(vaultCol(uid));
        var items = [];
        last = {};
        snap.forEach(function (d) { var o = d.data(); items.push(o); last[d.id] = JSON.stringify(toDoc(o)); });
        items.sort(function (x, y) { return (y.addedAt || 0) - (x.addedAt || 0); });
        return items;
      },
      syncVault: function (items) {
        var u = auth.currentUser; if (!u) return Promise.resolve();
        queue = queue.then(async function () {
          var seen = {}, ops = [];
          items.forEach(function (a) {
            var id = docId(a), d = toDoc(a), sig = JSON.stringify(d);
            seen[id] = true;
            if (last[id] !== sig) ops.push({ t: "set", id: id, d: d, sig: sig });
          });
          Object.keys(last).forEach(function (id) { if (!seen[id]) ops.push({ t: "del", id: id }); });
          for (var c of chunks(ops, 400)) {
            var b = F.writeBatch(db);
            c.forEach(function (o) {
              var r = F.doc(db, "users", u.uid, "vault", o.id);
              if (o.t === "set") b.set(r, o.d); else b.delete(r);
            });
            await b.commit();
            c.forEach(function (o) { if (o.t === "set") last[o.id] = o.sig; else delete last[o.id]; });
          }
        });
        queue = queue.catch(function (e) { window.dispatchEvent(new CustomEvent("mv-syncerr", { detail: e && e.code || String(e) })); });
        return queue;
      },

      deleteAccount: async function (username) {
        var u = auth.currentUser; if (!u) throw { code: "no-user" };
        var viaGoogle = u.providerData.some(function (p) { return p.providerId === "google.com"; });
        if (viaGoogle) { await Au.reauthenticateWithPopup(u, new Au.GoogleAuthProvider()); }
        else {
          var age = Date.now() - Date.parse(u.metadata.lastSignInTime || 0);
          if (!(age < 240000)) throw { code: "reauth-needed" };
        }
        var snap = await F.getDocs(vaultCol(u.uid));
        var refs = [];
        snap.forEach(function (d) { refs.push(d.ref); });
        for (var c of chunks(refs, 400)) { var b = F.writeBatch(db); c.forEach(function (r) { b.delete(r); }); await b.commit(); }
        var fin = F.writeBatch(db);
        fin.delete(userDoc(u.uid));
        if (username) fin.delete(F.doc(db, "usernames", username));
        await fin.commit();
        await Au.deleteUser(u);
        last = {};
      }
    };
    window.MV = MV;
    Au.getRedirectResult(auth).catch(function (e) { window.dispatchEvent(new CustomEvent("mv-autherr", { detail: e && e.code || "redirect" })); });
    window.dispatchEvent(new Event("mv-ready"));
  } catch (err) {
    window.MV_ERR = String(err && err.message || err);
    window.dispatchEvent(new Event("mv-fail"));
  }
})();
