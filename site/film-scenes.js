// The scenes of the landing page's films, each playing real screenshots of Statiku (scripts/shots.ts):
//   frames  [at ms, picture]                     which picture shows from that moment
//   beats   [at ms, target, press ms, label]     where the cursor rests (a box in the picture; null hides it), and
//                                                what it's doing, in a glowing label beside it
//   pings   [at ms, target]                      a visitor arriving: a green ring there
// Paced like a product video: a scene every six to eight seconds, a new picture every two or three.
window.STATIKU_SCENES = {
  // The film at the top of the page: seeing visitors, and following them to the sale.
  main: [
    {
      id: "live", tab: "Live", title: "Every visitor, the moment they arrive.",
      caption: "A live globe of who's on your site right now. Tap a country, then a city; visitors who choose to share their location show on their street.",
      url: "Live view · Notchlight", dur: 8400, glow: "#29c46b",
      frames: [[0, "live-world"], [2000, "live-finland"], [4000, "live-kuopio"], [5900, "live-street"]],
      beats: [[0, null], [400, "liveCount", 0, "34 people on the site now"], [1000, "rowFinland", 0, "Opening Finland"], [1750, "rowFinland", 250, "Opening Finland"],
        [2800, "rowKuopio", 0, "Into Kuopio"], [3700, "rowKuopio", 250, "Into Kuopio"], [4600, "rowShared", 0, "A visitor who shared their street"], [5500, "rowShared", 250, "A visitor who shared their street"], [6600, null]],
      pings: [[200, "liveCount"], [800, "liveCount"]],
    },
    {
      id: "analytics", tab: "Analytics", title: "Every number, for any period.",
      caption: "Visitors, page views, bounce rate and time on site, by hour, day, week, month or year. Pick a period, and click any source, page or country to see only its visits.",
      url: "Analytics · Notchlight", dur: 7000, glow: "#2fb3eb",
      frames: [[0, "an-30"], [1500, "an-range"], [2700, "an-90"], [4200, "an-hn"]],
      beats: [[0, null], [300, "kpiVisitors", 0, "Visitors, last 30 days"], [900, "rangeButton", 0, "Choosing a period"], [1300, "rangeButton", 250, "Choosing a period"],
        [2000, "item90", 0, "Last 90 days"], [2500, "item90", 250, "Last 90 days"], [3300, null], [4500, "chip", 0, "Only Hacker News visits"], [6300, null]],
    },
    {
      id: "sales", tab: "To the sale", title: "From the first visit to the sale.",
      caption: "See which sources bring downloads, installs, trials and sales, and what each one earned. Add the app SDK, and your Mac or iOS app joins the same story.",
      url: "Analytics · Notchlight", dur: 7800, glow: "#f5a524",
      frames: [[0, "conv"], [2600, "revenue"], [5200, "app"]],
      beats: [[0, null], [400, "convHN", 0, "Hacker News, to the sale"], [1600, "funnel", 0, "Visit, download, install, licence"], [3000, "callout", 0, "What each source earned"],
        [5600, "installs", 0, "The app's installs"], [7200, null]],
    },
    {
      id: "history", tab: "Your history", title: "Bring your history along.",
      caption: "Import from Google Analytics, Plausible, GitHub releases or a file from any other tool, and your charts reach back to your very first visitor.",
      url: "Import history · Notchlight", dur: 6200, glow: "#8b7cf6",
      frames: [[0, "import"], [2900, "an-all"]],
      beats: [[0, null], [400, "googleButton", 0, "Connecting Google Analytics"], [1400, "drop", 0, "Or dropping in a file"], [2300, "drop", 250, "Or dropping in a file"],
        [3400, "historyNote", 0, "Back to the first visitor"], [5600, null]],
    },
    {
      id: "setup", tab: "Set up", title: "On your site in a minute.",
      caption: "Type your address, then paste one line or follow the steps for WordPress, Shopify, Wix and the rest. It turns green the moment your first visitor arrives.",
      url: "Set up · victorabuchi.com", dur: 6800, glow: "#00a47c",
      frames: [[0, "add"], [1700, "setup-wait"], [4000, "setup-ok"]],
      beats: [[0, null], [400, "addButton", 0, "Adding a website"], [1200, "addButton", 250, "Adding a website"], [2200, "wordpress", 0, "Steps for WordPress"], [2700, "wordpress", 250, "Steps for WordPress"],
        [3500, "status", 0, "Waiting for the first visit"], [4200, "status", 0, "It's counting"], [6200, null]],
      pings: [[4100, "status"]],
    },
    {
      id: "alerts", tab: "Alerts", title: "It tells you when it matters.",
      caption: "An email when your site goes quiet or a rush of visitors arrives, and every Monday a match report: last week against the week before, by email or in Slack.",
      url: "Site settings · Notchlight", dur: 7800, glow: "#eb6834",
      frames: [[0, "alerts"], [2400, "email"], [5000, "report"]],
      beats: [[0, null], [500, "surge", 0, "Alerts for a rush"], [1500, "surge", 250, "Alerts for a rush"], [3000, "mailButton", 0, "A rush, while it's happening"],
        [5600, "reportButton", 0, "Monday's match report"], [7200, null]],
    },
  ],
  // The second film, further down: what other analytics don't do.
  more: [
    {
      id: "match", tab: "Match view", title: "Your launch day, live on a TV.",
      caption: "A scoreboard of who's on now, today's goals and takings, momentum and live commentary, with a goal moment when a sale lands. Share it at a link of its own.",
      url: "Match view · Notchlight", dur: 7200, glow: "#5ee69a",
      frames: [[0, "match"], [3300, "match-goal"], [6000, "match"]],
      beats: [[0, null], [500, "matchNow", 0, "Who's on the site now"], [1500, "commentary", 0, "Live commentary"], [2600, "matchGoals", 0, "Goals today"], [3300, null],
        [6100, "shareButton", 0, "Sharing the scoreboard"], [6700, "shareButton", 250, "Sharing the scoreboard"]],
    },
    {
      id: "pitch", tab: "On the move", title: "Watch visitors move through your site.",
      caption: "Every visitor as a dot on the page they're on: it glides to the next page as they browse, and ripples when they click a link or button, live, like a match.",
      url: "Match view · Notchlight", dur: 6600, glow: "#29c46b",
      frames: [[0, "pitch-1"], [2000, "pitch-2"], [4000, "pitch-3"]],
      beats: [[0, null], [400, "pitchZone", 0, "Everyone on the home page"], [2200, "pitchMoved", 0, "Heading to pricing"], [4200, "kickLabel", 0, "A click on Buy"], [6000, null]],
    },
    {
      id: "ratings", tab: "Page scores", title: "Every page, rated out of ten.",
      caption: "Assists show which pages and sources set up each sale, scores rate every page, and the speed report flags slow pages and script errors. Ask what changed, in plain words.",
      url: "Analytics · Notchlight", dur: 8400, glow: "#ffd60a",
      frames: [[0, "ratings"], [2800, "injuries"], [5400, "ask"]],
      beats: [[0, null], [500, "motm", 0, "The best page this month"], [1600, "topAssist", 0, "Pages that set up sales"], [3100, "vital", 0, "Speed for real visitors"],
        [4100, "slowPage", 0, "A slow page"], [4900, "askButton", 0, "Asking what changed"], [5300, "askButton", 250, "Asking what changed"], [6300, "changes", 0, "The answer, from your numbers"], [7700, null]],
    },
    {
      id: "heatmaps", tab: "Heatmaps", title: "See where they click.",
      caption: "The heat of every click over your real page, the links and buttons clicked most, and how far down people read, without recording anyone's screen.",
      url: "Heatmaps · Notchlight", dur: 6600, glow: "#ff6b3d",
      frames: [[0, "heat"], [3400, "heat-read"]],
      beats: [[0, null], [600, "topClick", 0, "The most clicked button"], [2000, "heatToggle", 0, "Your real page behind"], [3700, "scrollMark", 0, "How far down they read"], [5900, null]],
    },
    {
      id: "numbers", tab: "Numbers", title: "Track any number, live.",
      caption: "Send match scores, installs, sales or a sensor's reading from anywhere with one call, or upload a file of them, and each becomes a live tile.",
      url: "Websites", dur: 6600, glow: "#4cc9f0",
      frames: [[0, "numbers"], [1800, "numbers-live"], [3800, "numbers-send"]],
      beats: [[0, null], [500, "tileWidgets", 0, "A number from the app"], [1900, "tileWidgets", 0, "Updated live"], [4300, "copyCurl", 0, "One call sends one"], [4800, "copyCurl", 250, "One call sends one"], [5900, null]],
      pings: [[1800, "tileWidgets"]],
    },
  ],
};
