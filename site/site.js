// The landing page's small interactions: monthly or yearly prices, and the footer's launch week.
(() => {
  // Prices: each plan carries both, and the period buttons pick which shows.
  const periods = document.querySelectorAll(".period button");
  for (const button of periods) {
    button.addEventListener("click", () => {
      const yearly = button.dataset.period === "year";
      for (const b of periods) b.setAttribute("aria-selected", String(b === button));
      for (const price of document.querySelectorAll(".plan .price")) {
        price.querySelector("b").textContent = yearly ? price.dataset.year : price.dataset.month;
        price.querySelector("span").textContent = yearly ? "a year" : "a month";
      }
    });
  }

  // The footer's launch week: seven days, today first. Each tap sends a day more visitors; a day far above the rest
  // turns live green, as a launch would.
  const week = document.getElementById("footWeek"), note = document.getElementById("footNote");
  if (!week) return;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], now = new Date();
  const visits = Array.from({ length: 7 }, (_, i) => 12 + ((i * 7) % 9));
  week.innerHTML = visits.map((_, i) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    return `<button type="button" class="fday" aria-label="${names[day.getDay()]}: send visitors"><i></i><span>${names[day.getDay()]}</span></button>`;
  }).join("");
  const days = [...week.children];
  const draw = () => {
    const top = Math.max(...visits) * 1.25;
    days.forEach((d, i) => {
      d.style.setProperty("--h", `${Math.max(6, (100 * visits[i]) / top)}%`);
      d.classList.toggle("peak", visits[i] >= 3 * Math.max(...visits.filter((_, j) => j !== i)));
      d.setAttribute("aria-label", `${names[new Date(now.getFullYear(), now.getMonth(), now.getDate() + i).getDay()]}: ${visits[i]} visitors`);
    });
  };
  draw();
  week.addEventListener("click", (e) => {
    const day = e.target.closest(".fday");
    if (!day) return;
    const i = days.indexOf(day);
    visits[i] = Math.round(visits[i] * 1.6 + 8);
    draw();
    const total = visits.reduce((a, b) => a + b, 0);
    note.textContent = day.classList.contains("peak") ? `${visits[i].toLocaleString("en-US")} visitors in a day. That's a launch.` : `${total.toLocaleString("en-US")} visitors this week, and counting.`;
  });
})();
