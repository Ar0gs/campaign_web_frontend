// ── AROGS CAMPAIGN — app.js ──

const CONFIG = {
  supabaseUrl: 'https://tpteskmuuutobzkegors.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwdGVza211dXV0b2J6a2Vnb3JzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDA2OTgsImV4cCI6MjA5NDg3NjY5OH0.6meW7ZwgSnIqv-rb3w7G5X-5GapjMCERacfUhhkc5hM',
  vapidPublicKey: 'BJTXftjErgkU9Qgdfudu2wnpa52aH0r3h_X-xfZIxoJGOYGCfasNc5h6TF6lpR_a4iXK4KGVZBYRj4nZ7lpovu8',
  serverUrl: 'https://campaignweb-production.up.railway.app'
};

// ── SUPABASE HELPERS ──
async function supabaseInsert(table, record) {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': CONFIG.supabaseKey,
      'Authorization': `Bearer ${CONFIG.supabaseKey}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(record)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function supabaseSelect(table, params = '') {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}?${params}`, {
    headers: {
      'apikey': CONFIG.supabaseKey,
      'Authorization': `Bearer ${CONFIG.supabaseKey}`
    }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── SERVICE WORKER ──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Wait for SW to become active before subscribing to push
    if (reg.installing || reg.waiting) {
      await new Promise(resolve => {
        const sw = reg.installing || reg.waiting;
        sw.addEventListener('statechange', function handler(e) {
          if (e.target.state === 'activated') {
            sw.removeEventListener('statechange', handler);
            resolve();
          }
        });
      });
    }
    return reg;
  } catch (err) {
    console.error('[SW] Registration failed:', err);
    return null;
  }
}

// ── VAPID KEY CONVERSION ──
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ── PUSH SUBSCRIPTION ──
async function subscribeToPush(registration) {
  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.vapidPublicKey)
    });
  } catch (err) {
    console.error('[Push] Subscription failed:', err);
    return null;
  }
}

// ── SAVE SUPPORTER ──
// Sends to backend (which handles push + saves to Supabase),
// then also saves directly to Supabase as a safety fallback.
async function saveToBackend(email, phone, pushSub) {
  try {
    const res = await fetch(`${CONFIG.serverUrl}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: pushSub ? pushSub.toJSON() : null,
        email: email || null,
        phone: phone || null
      })
    });
    if (!res.ok) console.error('[Backend] /subscribe error:', await res.text());
    return res.ok;
  } catch (e) {
    console.error('[Backend] Could not reach server:', e.message);
    return false;
  }
}

async function saveToSupabase(email, phone, pushSub) {
  // FIX: Never include email key when it's empty — avoids NULL unique
  // constraint violations that silently blocked mobile users from saving.
  const record = {
    phone: phone || null,
    push_subscription: pushSub ? JSON.stringify(pushSub.toJSON()) : null,
    joined_at: new Date().toISOString(),
    notifications_enabled: !!pushSub
  };
  if (email) record.email = email;
  return supabaseInsert('supporters', record);
}

// ── FULL SUBSCRIBE FLOW (shared by modal + enable button) ──
async function runSubscribeFlow(email, phone, feedbackEl) {
  const setMsg = (msg, color = 'var(--gold)') => {
    if (feedbackEl) { feedbackEl.textContent = msg; feedbackEl.style.color = color; }
  };

  setMsg('Joining the movement...');

  const reg = await registerServiceWorker();
  let pushSub = null;

  if (reg && 'Notification' in window) {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      pushSub = await subscribeToPush(reg);
    } else {
      setMsg('⚠️ Notifications blocked. Enable them in browser settings.', '#e05555');
    }
  }

  // Save to backend first, then Supabase as fallback
  const backendOk = await saveToBackend(email, phone, pushSub);
  if (!backendOk) {
    // Backend failed — save directly to Supabase so data isn't lost
    await saveToSupabase(email, phone, pushSub);
  }

  markJoined();
  setMsg('✓ You\'re part of the movement!');
  return pushSub;
}

// ── MODAL ──
window.handleModalYes = async function() {
  const email = document.getElementById('modal-email').value.trim();
  const phone = document.getElementById('modal-phone').value.trim();
  const feedback = document.getElementById('modal-feedback');

  if (!email && !phone) {
    feedback.textContent = 'Please enter at least your email or phone number.';
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    feedback.textContent = 'Please enter a valid email address.';
    return;
  }

  try {
    await runSubscribeFlow(email, phone, feedback);
    setTimeout(() => {
      document.getElementById('modal-overlay').classList.add('hidden');
      showToast('Welcome to the IMPACT Movement! Arogs thanks you for joining.', 5000);
      loadSupporterCount();
      updateNotifButton();
    }, 1200);
  } catch (err) {
    console.error('Modal error:', err);
    feedback.textContent = '⚠️ Something went wrong. Please try again.';
    feedback.style.color = '#e05555';
  }
};

window.handleModalNo = function() {
  markJoined();
  document.getElementById('modal-overlay').classList.add('hidden');
};

// ── ENABLE NOTIFICATIONS BUTTON ──
// Injected into the page for users who missed or dismissed the modal.
function injectNotifButton() {
  // Don't inject if already there
  if (document.getElementById('notif-enable-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'notif-enable-btn';
  btn.innerHTML = '🔔 Enable Notifications';
  btn.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    background: #C9A84C;
    color: #000;
    border: none;
    border-radius: 50px;
    padding: 12px 22px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 4px 20px rgba(201,168,76,0.4);
    display: flex;
    align-items: center;
    gap: 8px;
    transition: opacity 0.3s, transform 0.3s;
  `;

  btn.addEventListener('mouseenter', () => btn.style.transform = 'scale(1.05)');
  btn.addEventListener('mouseleave', () => btn.style.transform = 'scale(1)');

  btn.addEventListener('click', async () => {
    btn.innerHTML = '⏳ Enabling...';
    btn.disabled = true;

    try {
      // If they haven't given email/phone yet, ask for email inline
      let email = localStorage.getItem('arogs_email') || '';
      let phone = localStorage.getItem('arogs_phone') || '';

      if (!email && !phone) {
        email = prompt('Enter your email to receive updates (optional):') || '';
        phone = prompt('Enter your phone number (optional):') || '';
        if (email) localStorage.setItem('arogs_email', email);
        if (phone) localStorage.setItem('arogs_phone', phone);
      }

      const pushSub = await runSubscribeFlow(email, phone, null);

      if (pushSub) {
        btn.innerHTML = '✅ Notifications Enabled!';
        btn.style.background = '#2a9d2a';
        setTimeout(() => btn.remove(), 3000);
        showToast('You\'ll now receive updates from Arogs!', 4000);
      } else {
        btn.innerHTML = '⚠️ Could not enable — check browser settings';
        btn.style.background = '#c0392b';
        btn.style.color = '#fff';
        setTimeout(() => {
          btn.innerHTML = '🔔 Enable Notifications';
          btn.style.background = '#C9A84C';
          btn.style.color = '#000';
          btn.disabled = false;
        }, 4000);
      }
    } catch (e) {
      console.error('Enable notif error:', e);
      btn.innerHTML = '🔔 Enable Notifications';
      btn.disabled = false;
    }
  });

  document.body.appendChild(btn);
}

// Show/hide the button based on current subscription state
async function updateNotifButton() {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!reg) return;

  const sub = await reg.pushManager.getSubscription().catch(() => null);
  const permission = Notification.permission;

  const btn = document.getElementById('notif-enable-btn');

  // Hide button if already subscribed
  if (sub && permission === 'granted') {
    if (btn) btn.remove();
    return;
  }

  // Show button if not subscribed and not permanently denied
  if (permission !== 'denied') {
    injectNotifButton();
  }
}

// ── TOAST ──
function showToast(msg, duration = 4000) {
  const toast = document.getElementById('notif-toast');
  if (!toast) return;
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── COUNT UP ANIMATION ──
function animateCountUp(el, target, duration = 2000) {
  const start = performance.now();
  const isLarge = target >= 1000;
  const step = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.floor(eased * target);
    el.textContent = isLarge ? value.toLocaleString() + '+' : value;
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = isLarge ? target.toLocaleString() + '+' : target;
  };
  requestAnimationFrame(step);
}

// ── SCROLL REVEAL ──
function setupScrollReveal() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => entry.target.classList.add('visible'), i * 80);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

// ── COUNT UP ON SCROLL ──
function setupCountAnimation() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.querySelectorAll('[data-target]').forEach(el => {
          animateCountUp(el, parseInt(el.dataset.target));
        });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  const impactSection = document.getElementById('impact');
  if (impactSection) observer.observe(impactSection);
}

// ── SUPPORTER COUNT ──
async function loadSupporterCount() {
  try {
    const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/supporters?select=id`, {
      headers: {
        'apikey': CONFIG.supabaseKey,
        'Authorization': `Bearer ${CONFIG.supabaseKey}`,
        'Prefer': 'count=exact',
        'Range': '0-0'
      }
    });
    const range = res.headers.get('Content-Range');
    const count = range ? parseInt(range.split('/')[1]) : 0;
    const el = document.getElementById('supporter-count');
    if (el) animateCountUp(el, Math.max(count, 47), 1500);
    loadSupporterTags();
  } catch (err) {
    const el = document.getElementById('supporter-count');
    if (el) animateCountUp(el, 47, 1500);
  }
}

// ── SUPPORTER TAGS ──
async function loadSupporterTags() {
  const tagContainer = document.getElementById('supporter-tags');
  if (!tagContainer) return;
  const seedTags = [
    'A.O. — 100L Medicine', 'T.A. — 200L Law', 'K.I. — 300L Engineering',
    'F.B. — 400L Sciences', 'O.M. — 100L Social Sci', 'A.T. — 200L Education',
    'S.K. — 300L Agriculture', 'D.O. — 400L Arts', 'P.A. — Postgrad',
    'Y.M. — 100L Pharmacy', 'R.T. — 200L Technology', 'J.O. — 300L Admin',
    'E.A. — 400L Medicine', 'N.S. — 100L Sciences', 'B.O. — 200L Engineering',
    'C.I. — 300L Law', 'M.A. — 400L Education', 'H.T. — Postgrad',
    'L.O. — 100L Agriculture', 'V.A. — 200L Arts', 'U.M. — 300L Social Sci',
    'Q.B. — 400L Pharmacy', 'W.T. — 100L Technology', 'X.O. — 200L Sciences',
  ];
  try {
    const data = await supabaseSelect('supporters', 'select=email,phone,joined_at&order=joined_at.desc&limit=50');
    const tags = data.map(s => {
      const name = s.email ? s.email.split('@')[0].substring(0, 6) + '...' : 'Anon';
      return `<div class="stag">${name}</div>`;
    });
    tagContainer.innerHTML = (tags.length > 0 ? tags.join('') : '') +
      seedTags.map(t => `<div class="stag">${t}</div>`).join('');
  } catch {
    tagContainer.innerHTML = seedTags.map(t => `<div class="stag">${t}</div>`).join('');
  }
}

// ── NAV ──
function setupNav() {
  const nav = document.querySelector('nav');
  if (!nav) return;
  window.addEventListener('scroll', () => {
    if (window.scrollY > 80) {
      nav.style.background = 'rgba(10,10,10,0.97)';
      nav.style.borderBottom = '1px solid rgba(201,168,76,0.1)';
    } else {
      nav.style.background = 'linear-gradient(to bottom, rgba(10,10,10,0.95), transparent)';
      nav.style.borderBottom = 'none';
    }
  });
}

// ── SESSION ──
function shouldShowModal() {
  return !localStorage.getItem('arogs_impact_joined');
}
function markJoined() {
  localStorage.setItem('arogs_impact_joined', '1');
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', async () => {
  if (!shouldShowModal()) {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  setupScrollReveal();
  setupCountAnimation();
  setupNav();
  loadSupporterCount();

  // Register SW on every load so returning visitors stay subscribed
  await registerServiceWorker();

  // Show enable-notifications button to anyone not yet subscribed
  updateNotifButton();
});
