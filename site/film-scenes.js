// The scenes of the landing page's film, each playing real screenshots of Statiku (scripts/shots.ts):
//   frames  [at ms, picture]              which picture shows from that moment
//   beats   [at ms, target, press ms]     where the cursor rests (a box in the picture; null hides it)
//   pings   [at ms, target]               a visitor arriving: a green ring there
window.STATIKU_SCENES = [
  {
    id: "live", tab: "Live", title: "Every visitor, the moment they arrive.",
    caption: "A live globe of who's on your site right now. Tap a country, then a city; visitors who choose to share their location show on their street.",
    url: "Live view · Notchlight", dur: 13000, glow: "#29c46b",
    frames: [[0, "live-world"], [3200, "live-finland"], [6400, "live-kuopio"], [9200, "live-street"]],
    beats: [[0, null], [700, "liveCount"], [1700, "rowFinland"], [2900, "rowFinland", 300], [4600, "rowKuopio"], [6000, "rowKuopio", 300], [7400, "rowShared"], [8800, "rowShared", 300], [10400, null]],
    pings: [[300, "liveCount"], [1300, "liveCount"]],
  },
  {
    id: "analytics", tab: "Analytics", title: "Every number, for any period.",
    caption: "Visitors, page views, bounce rate and time on site, by hour, day, week, month or year. Pick a period, and click any source, page or country to see only its visits.",
    url: "Analytics · Notchlight", dur: 11000, glow: "#2fb3eb",
    frames: [[0, "an-30"], [2400, "an-range"], [4300, "an-90"], [6600, "an-hn"]],
    beats: [[0, null], [500, "kpiVisitors"], [1400, "rangeButton"], [2100, "rangeButton", 300], [3100, "item90"], [4000, "item90", 300], [5200, null], [7000, "chip"], [9800, null]],
  },
  {
    id: "sales", tab: "To the sale", title: "From the first visit to the sale.",
    caption: "See which sources bring downloads, installs, trials and sales, not just visits. Add the app SDK, and your Mac or iOS app joins the same story.",
    url: "Analytics · Notchlight", dur: 10000, glow: "#f5a524",
    frames: [[0, "conv"], [5400, "app"]],
    beats: [[0, null], [700, "convHN"], [2700, "funnel"], [6000, "installs"], [9000, null]],
  },
  {
    id: "history", tab: "Your history", title: "Bring your history along.",
    caption: "Import from Google Analytics, Plausible, GitHub releases or a file from any other tool, and your charts reach back to your very first visitor.",
    url: "Import history · Notchlight", dur: 10000, glow: "#8b7cf6",
    frames: [[0, "import"], [4600, "an-all"]],
    beats: [[0, null], [700, "googleButton"], [2300, "drop"], [3700, "drop", 300], [5400, "historyNote"], [8800, null]],
  },
  {
    id: "setup", tab: "Set up", title: "On your site in a minute.",
    caption: "Type your address, then paste one line or follow the steps for WordPress, Shopify, Wix and the rest. It turns green the moment your first visitor arrives.",
    url: "Set up · victorabuchi.com", dur: 11000, glow: "#00a47c",
    frames: [[0, "add"], [2700, "setup-wait"], [6400, "setup-ok"]],
    beats: [[0, null], [700, "addButton"], [2000, "addButton", 300], [3600, "wordpress"], [4300, "wordpress", 300], [5600, "status"], [9800, null]],
    pings: [[6500, "status"]],
  },
  {
    id: "alerts", tab: "Alerts", title: "It tells you when it matters.",
    caption: "An email when your site goes quiet, saying whether it's down or lost its code, and another when a rush of visitors arrives, with where they're coming from.",
    url: "Site settings · Notchlight", dur: 9500, glow: "#eb6834",
    frames: [[0, "alerts"], [4200, "email"]],
    beats: [[0, null], [800, "surge"], [2600, "surge", 300], [5200, "mailButton"], [8600, null]],
  },
];
