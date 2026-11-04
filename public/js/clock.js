// Live clock — settings come from the server ('clock_settings'), set in the control panel.
// timeZone: 'local' = this computer's time, otherwise an IANA zone like 'America/New_York'.
let clockSettings = { show: true, timeZone: 'local', hour12: false };
let clockFormatter = null;

function buildClockFormatter() {
    const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !!clockSettings.hour12 };
    if (clockSettings.timeZone && clockSettings.timeZone !== 'local') opts.timeZone = clockSettings.timeZone;
    try {
        clockFormatter = new Intl.DateTimeFormat('vi-VN', opts);
    } catch (e) {
        // Unknown zone name — fall back to local time
        delete opts.timeZone;
        clockFormatter = new Intl.DateTimeFormat('vi-VN', opts);
    }
}

function applyClockSettings(settings) {
    clockSettings = { ...clockSettings, ...(settings || {}) };
    const container = document.querySelector('.live-clock-container');
    if (container) container.style.display = clockSettings.show ? '' : 'none';
    buildClockFormatter();
    updateClock();
}

function updateClock() {
    const clockElement = document.getElementById('live-clock');
    if (!clockElement) return;
    if (!clockFormatter) buildClockFormatter();
    clockElement.textContent = clockFormatter.format(new Date());
}

document.addEventListener('DOMContentLoaded', () => {
    updateClock();
    setInterval(updateClock, 1000);
    // `socket` is created by the page's own script (overlay.html / app.js)
    if (typeof socket !== 'undefined') socket.on('clock_settings', applyClockSettings);
});
