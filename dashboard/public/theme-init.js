(function () {
  try {
    if (localStorage.getItem('intel-dark') === '1') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
