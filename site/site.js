// The landing page's small interactions: monthly or yearly prices.
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
})();
