const button = document.getElementById('counter');
let taps = 0;
button.addEventListener('click', () => {
  taps += 1;
  button.textContent = `Taps: ${taps}`;
});
