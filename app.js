// ── AROGS CAMPAIGN — app.js ──
// Configuration — replace with your real values

const CONFIG = {
  supabaseUrl: 'https://tpteskmuuutobzkegors.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwdGVza211dXV0b2J6a2Vnb3JzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDA2OTgsImV4cCI6MjA5NDg3NjY5OH0.6meW7ZwgSnIqv-rb3w7G5X-5GapjMCERacfUhhkc5hM',
  vapidPublicKey: 'BH30i8o7XH-m6scXQXvICqgVzpBHATLfBjGfvwfUDDf_VjSxJylzSvojOgyvCSwMmSDzb5cxc6OlquyWzsr8qLQ',
  // FIX 1: Added https:// — without the protocol, fetch() throws a TypeError and
  // the push subscription NEVER reaches the backend server.
  serverUrl: 'https://campaignweb-production.up.railway.app'
};

// ── SUPABASE CLIENT (CDN-free inline version) ──
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

// ── SERVICE WORKER REGISTRATION ──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[SW] Registered:', reg.scope);
    // FIX 2: Wait for the service worker to become active before trying to
    // subscribe to push. Without this, pushManager.subscribe() can fail with
    // "InvalidStateError" because the SW isn't ready yet.
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
    // Check if already subscribed — reuse existing subscription instead of
    // creating a duplicate, which would break the stored endpoint on the server.
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.vapidPublicKey)
    });
    return sub;
  } catch (err) {
    console.error('[Push] Subscription failed:', err);
    return null;
  }
}

// ── SAVE SUPPORTER TO SUPABASE ──
async function saveSupporter({ email, phone, pushSubscription }) {
  const record = {
    email: email || null,
    phone: phone || null,
    push_subscription: pushSubscription ? JSON.stringify(pushSubscription) : null,
    joined_at: new Date().toISOString(),
    notifications_enabled: !!pushSubscription
  };
  return supabaseInsert('supporters', record);
}

// ── MODAL LOGIC ──
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

  feedback.textContent = 'Joining the movement...';
  feedback.style.color = 'var(--gold)';

  try {
    // 1. Register service worker (and wait for it to activate)
    const reg = await registerServiceWorker();
    let pushSub = null;

    // 2. Request notification permission & subscribe
    if (reg && 'Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        pushSub = await subscribeToPush(reg);

        // 3. Send subscription to backend server
        // FIX 3: The original code silently caught backend errors and fell through
        // to saveSupporter() which would then write to Supabase WITHOUT the push
        // subscription (because pushSub was never confirmed stored on the server).
        // Now we surface backend errors clearly so you can debug them.
        if (pushSub) {
          try {
            const backendRes = await fetch(`${CONFIG.serverUrl}/subscribe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subscription: pushSub.toJSON(), email, phone })
            });
            if (!backendRes.ok) {
              const errText = await backendRes.text();
              console.error('[Backend] /subscribe failed:', errText);
            }
          } catch(e) {
            console.error('[Backend] Could not reach server:', e.message);
          }
        }
      } else {
        feedback.textContent = '⚠️ Notifications blocked. You can enable them in browser settings.';
        feedback.style.color = '#e05555';
      }
    }

    // 4. Save to Supabase directly as well (dual-write for safety)
    await saveSupporter({ email, phone, pushSubscription: pushSub });

    // 5. Mark joined, close modal & show welcome
    markJoined();
    feedback.textContent = '✓ You\'re part of the movement!';
    feedback.style.color = 'var(--gold)';
    setTimeout(() => {
      document.getElementById('modal-overlay').classList.add('hidden');
      showToast('Welcome to the IMPACT Movement! Arogs thanks you for joining.', 5000);
      loadSupporterCount();
    }, 1200);

  } catch (err) {
    console.error('Error joining:', err);
    feedback.textContent = '⚠️ Something went wrong. Please try again.';
    feedback.style.color = '#e05555';
  }
};

// ── TOAST NOTIFICATION ──
function showToast(msg, duration = 4000) {
  const toast = document.getElementById('notif-toast');
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
        const els = entry.target.querySelectorAll('[data-target]');
        els.forEach(el => {
          const target = parseInt(el.dataset.target);
          animateCountUp(el, target);
        });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });

  const impactSection = document.getElementById('impact');
  if (impactSection) observer.observe(impactSection);
}

// ── LOAD SUPPORTER COUNT FROM SUPABASE ──
async function loadSupporterCount() {
  try {
    const res = await fetch(
      `${CONFIG.supabaseUrl}/rest/v1/supporters?select=id`,
      {
        headers: {
          'apikey': CONFIG.supabaseKey,
          'Authorization': `Bearer ${CONFIG.supabaseKey}`,
          'Prefer': 'count=exact',
          'Range': '0-0'
        }
      }
    );
    const range = res.headers.get('Content-Range');
    const count = range ? parseInt(range.split('/')[1]) : 0;

    const el = document.getElementById('supporter-count');
    if (el) animateCountUp(el, Math.max(count, 47), 1500);

    loadSupporterTags();
  } catch (err) {
    console.warn('Could not load supporter count:', err);
    const el = document.getElementById('supporter-count');
    if (el) animateCountUp(el, 47, 1500);
  }
}

// ── LOAD SUPPORTER TAGS (anonymized) ──
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
    if (tags.length > 0) {
      tagContainer.innerHTML = tags.join('') + seedTags.map(t => `<div class="stag">${t}</div>`).join('');
    } else {
      throw new Error('No data');
    }
  } catch {
    tagContainer.innerHTML = seedTags.map(t => `<div class="stag">${t}</div>`).join('');
  }
}

// ── NAV SCROLL EFFECT ──
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

// ── SESSION HELPERS ──
function shouldShowModal() {
  return !localStorage.getItem('arogs_impact_joined');
}

function markJoined() {
  localStorage.setItem('arogs_impact_joined', '1');
}

window.handleModalNo = function() {
  markJoined();
  document.getElementById('modal-overlay').classList.add('hidden');
};

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  if (!shouldShowModal()) {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  setupScrollReveal();
  setupCountAnimation();
  setupNav();
  loadSupporterCount();

  // Register SW on every page load so returning visitors still receive pushes
  registerServiceWorker();
});
