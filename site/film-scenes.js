// The scenes of the landing page's films, each playing real screenshots of Statiku (scripts/shots.ts):
//   frames  [at ms, picture]                     which picture shows from that moment
//   beats   [at ms, target, press ms, label]     where the cursor rests (a box in the picture; null hides it), and
//                                                what it's doing, in a glowing label beside it
//   pings   [at ms, target]                      a visitor arriving: a green ring there
// Paced like a product video you can follow: a scene every eight to eleven seconds, a new picture every three or so.
window.STATIKU_SCENES = {
  // The film at the top of the page: seeing visitors, and following them to the sale.
  main: [
    {
      id: "live", tab: "Live", title: "Every visitor, the moment they arrive.",
      caption: "A live globe of who's on your site right now. Tap a country, then a city; visitors who choose to share their location show on their street.",
      url: "Live view · Notchlight", dur: 10900, glow: "#29c46b",
      frames: [[0, "live-world"], [2600, "live-finland"], [5200, "live-kuopio"], [7650, "live-street"]],
      beats: [[0, null], [500, "liveCount", 0, "34 people on the site now"], [1300, "rowFinland", 0, "Opening Finland"], [2300, "rowFinland", 250, "Opening Finland"],
        [3650, "rowKuopio", 0, "Into Kuopio"], [4800, "rowKuopio", 250, "Into Kuopio"], [6000, "rowShared", 0, "A visitor who shared their street"], [7150, "rowShared", 250, "A visitor who shared their street"], [8600, null]],
      pings: [[250, "liveCount"], [1050, "liveCount"]],
    },
    {
      id: "analytics", tab: "Analytics", title: "Every number, for any period.",
      caption: "Visitors, page views, bounce rate and time on site, by hour, day, week, month or year. Pick a period, and click any source, page or country to see only its visits.",
      url: "Analytics · Notchlight", dur: 9100, glow: "#2fb3eb",
      frames: [[0, "an-30"], [1950, "an-range"], [3500, "an-90"], [5450, "an-hn"]],
      beats: [[0, null], [400, "kpiVisitors", 0, "Visitors, last 30 days"], [1150, "rangeButton", 0, "Choosing a period"], [1700, "rangeButton", 250, "Choosing a period"],
        [2600, "item90", 0, "Last 90 days"], [3250, "item90", 250, "Last 90 days"], [4300, null], [5850, "chip", 0, "Only Hacker News visits"], [8200, null]],
    },
    {
      id: "sales", tab: "To the sale", title: "From the first visit to the sale.",
      caption: "See which sources bring downloads, installs, trials and sales, and what each one earned. Add the app SDK, and your Mac or iOS app joins the same story.",
      url: "Analytics · Notchlight", dur: 10100, glow: "#f5a524",
      frames: [[0, "conv"], [3400, "revenue"], [6750, "app"]],
      beats: [[0, null], [500, "convHN", 0, "Hacker News, to the sale"], [2100, "funnel", 0, "Visit, download, install, licence"], [3900, "callout", 0, "What each source earned"],
        [7300, "installs", 0, "The app's installs"], [9350, null]],
    },
    {
      id: "history", tab: "Your history", title: "Bring your history along.",
      caption: "Import from Google Analytics, Plausible, GitHub releases or a file from any other tool, and your charts reach back to your very first visitor.",
      url: "Import history · Notchlight", dur: 8100, glow: "#8b7cf6",
      frames: [[0, "import"], [3750, "an-all"]],
      beats: [[0, null], [500, "googleButton", 0, "Connecting Google Analytics"], [1800, "drop", 0, "Or dropping in a file"], [3000, "drop", 250, "Or dropping in a file"],
        [4400, "historyNote", 0, "Back to the first visitor"], [7300, null]],
    },
    {
      id: "setup", tab: "Set up", title: "On your site in a minute.",
      caption: "Type your address, then paste one line or follow the steps for WordPress, Shopify, Wix and the rest. It turns green the moment your first visitor arrives.",
      url: "Set up · victorabuchi.com", dur: 8800, glow: "#00a47c",
      frames: [[0, "add"], [2200, "setup-wait"], [5200, "setup-ok"]],
      beats: [[0, null], [500, "addButton", 0, "Adding a website"], [1550, "addButton", 250, "Adding a website"], [2850, "wordpress", 0, "Steps for WordPress"], [3500, "wordpress", 250, "Steps for WordPress"],
        [4550, "status", 0, "Waiting for the first visit"], [5450, "status", 0, "It's counting"], [8050, null]],
      pings: [[5350, "status"]],
    },
    {
      id: "alerts", tab: "Alerts", title: "It tells you when it matters.",
      caption: "An email when your site goes quiet or a rush of visitors arrives, and every Monday a report: last week against the week before, by email or in Slack.",
      url: "Site settings · Notchlight", dur: 10100, glow: "#eb6834",
      frames: [[0, "alerts"], [3100, "email"], [6500, "report"]],
      beats: [[0, null], [650, "surge", 0, "Alerts for a rush"], [1950, "surge", 250, "Alerts for a rush"], [3900, "mailButton", 0, "A rush, while it's happening"],
        [7300, "reportButton", 0, "Monday's report"], [9350, null]],
    },
  ],
  // The second film, further down: what other analytics don't do.
  more: [
    {
      id: "match", tab: "TV view", title: "Your launch day, live on a TV.",
      caption: "A live board of who's on now, today's conversions and takings, momentum and commentary, with a moment for every sale as it lands. Share it at a link of its own.",
      url: "TV view · Notchlight", dur: 9400, glow: "#5ee69a",
      frames: [[0, "match"], [4300, "match-goal"], [7800, "match"]],
      beats: [[0, null], [650, "matchNow", 0, "Who's on the site now"], [1950, "commentary", 0, "Live commentary"], [3400, "matchGoals", 0, "Sales and sign-ups today"], [4300, null],
        [7950, "shareButton", 0, "Sharing the scoreboard"], [8700, "shareButton", 250, "Sharing the scoreboard"]],
    },
    {
      id: "pitch", tab: "On the move", title: "Watch visitors move through your site.",
      caption: "Every visitor as a dot on the page they're on: it glides to the next page as they browse, and ripples when they click a link or button, live.",
      url: "TV view · Notchlight", dur: 8600, glow: "#29c46b",
      frames: [[0, "pitch-1"], [2600, "pitch-2"], [5200, "pitch-3"]],
      beats: [[0, null], [500, "pitchZone", 0, "Everyone on the home page"], [2850, "pitchMoved", 0, "Heading to pricing"], [5450, "kickLabel", 0, "A click on Buy"], [7800, null]],
    },
    {
      id: "ratings", tab: "Page scores", title: "Every page, rated out of ten.",
      caption: "Assists show which pages and sources set up each sale, scores rate every page, and the speed report flags slow pages and script errors. Ask what changed, in plain words.",
      url: "Analytics · Notchlight", dur: 10900, glow: "#ffd60a",
      frames: [[0, "ratings"], [3650, "injuries"], [7000, "ask"]],
      beats: [[0, null], [650, "motm", 0, "The best page this month"], [2100, "topAssist", 0, "Pages that set up sales"], [4050, "vital", 0, "Speed for real visitors"],
        [5350, "slowPage", 0, "A slow page"], [6350, "askButton", 0, "Asking what changed"], [6900, "askButton", 250, "Asking what changed"], [8200, "changes", 0, "The answer, from your numbers"], [10000, null]],
    },
    {
      id: "heatmaps", tab: "Heatmaps", title: "See where they click.",
      caption: "The heat of every click over your real page, the links and buttons clicked most, and how far down people read, without recording anyone's screen.",
      url: "Heatmaps · Notchlight", dur: 8600, glow: "#ff6b3d",
      frames: [[0, "heat"], [4400, "heat-read"]],
      beats: [[0, null], [800, "topClick", 0, "The most clicked button"], [2600, "heatToggle", 0, "Your real page behind"], [4800, "scrollMark", 0, "How far down they read"], [7650, null]],
    },
    {
      id: "numbers", tab: "Trackers", title: "Track anything, live.",
      caption: "Send a number, a word or a yes/no from anywhere with one call (installs, scores, a sensor, a status), or upload a file, and chart it any way you like.",
      url: "Trackers", dur: 11000, glow: "#4cc9f0",
      frames: [[0, "numbers"], [2400, "numbers-live"], [4800, "tracker-pie"], [7900, "numbers-send"]],
      beats: [[0, null], [650, "tileWidgets", 0, "A tracker from the app"], [2500, "tileWidgets", 0, "Updated live"], [5100, "splitPick", 0, "Split by widget"],
        [6000, "pieChart", 0, "As a pie, or a line, bars, a table"], [8500, "copyCurl", 0, "One call sends one"], [9100, "copyCurl", 250, "One call sends one"], [10400, null]],
      pings: [[2400, "tileWidgets"]],
    },
  ],
};
