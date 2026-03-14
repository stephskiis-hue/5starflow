/* ============================================================
   5StarFlow — main.js
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* ----------------------------------------------------------
     1. STICKY NAV SHADOW
  ---------------------------------------------------------- */
  const nav = document.getElementById('nav');

  window.addEventListener('scroll', () => {
    if (window.scrollY > 60) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }, { passive: true });


  /* ----------------------------------------------------------
     1b. PRICING DROPDOWN
  ---------------------------------------------------------- */
  document.querySelectorAll('.nav-dropdown-wrap').forEach(wrap => {
    const toggle   = wrap.querySelector('.nav-dropdown-toggle');
    const dropdown = wrap.querySelector('.nav-dropdown');
    if (!toggle || !dropdown) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('open');
      // Close all other dropdowns first
      document.querySelectorAll('.nav-dropdown.open').forEach(d => {
        d.classList.remove('open');
        d.previousElementSibling && d.previousElementSibling.classList.remove('open');
      });
      if (!isOpen) {
        dropdown.classList.add('open');
        toggle.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
      }
    });

    // Close on outside click
    document.addEventListener('click', () => {
      dropdown.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });

    // Close when a dropdown link is clicked (mobile)
    dropdown.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        dropdown.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  });


  /* ----------------------------------------------------------
     2. MOBILE HAMBURGER MENU
  ---------------------------------------------------------- */
  const navToggle = document.getElementById('nav-toggle');
  const navMenu   = document.getElementById('nav-menu');

  navToggle.addEventListener('click', () => {
    navMenu.classList.toggle('open');
    navToggle.classList.toggle('active');
  });

  // Close menu when a link is tapped
  navMenu.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navMenu.classList.remove('open');
      navToggle.classList.remove('active');
    });
  });

  // Close menu if user clicks outside
  document.addEventListener('click', (e) => {
    if (navMenu.classList.contains('open') &&
        !navMenu.contains(e.target) &&
        !navToggle.contains(e.target)) {
      navMenu.classList.remove('open');
      navToggle.classList.remove('active');
    }
  });


  /* ----------------------------------------------------------
     3. SMOOTH SCROLL (offset for sticky nav height)
  ---------------------------------------------------------- */
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href === '#') return;

      const target = document.querySelector(href);
      if (!target) return;

      e.preventDefault();
      const navHeight = nav.offsetHeight;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });


  /* ----------------------------------------------------------
     4. FAQ ACCORDION
  ---------------------------------------------------------- */
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');

      // Close all
      document.querySelectorAll('.faq-item.open').forEach(openItem => {
        openItem.classList.remove('open');
      });

      // Open this one (unless it was already open)
      if (!isOpen) {
        item.classList.add('open');
      }
    });
  });


  /* ----------------------------------------------------------
     5. SCROLL REVEAL  (IntersectionObserver)
  ---------------------------------------------------------- */
  const revealEls = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: '0px 0px -40px 0px'
    });

    revealEls.forEach(el => observer.observe(el));
  } else {
    // Fallback: show everything
    revealEls.forEach(el => el.classList.add('visible'));
  }


  /* ----------------------------------------------------------
     6. ACTIVE NAV LINK  (highlight based on scroll position)
  ---------------------------------------------------------- */
  const sections   = document.querySelectorAll('main section[id]');
  const navLinks   = document.querySelectorAll('#nav-menu a[href^="#"]');

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        navLinks.forEach(link => {
          link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
        });
      }
    });
  }, {
    threshold: 0.4
  });

  sections.forEach(section => sectionObserver.observe(section));


  /* ----------------------------------------------------------
     7. ROI CALCULATOR
  ---------------------------------------------------------- */
  const slider = document.getElementById('jobs-slider');
  if (slider) {
    const jobsValue     = document.getElementById('jobs-value');
    const resultReviews = document.getElementById('result-reviews');
    const resultLeads   = document.getElementById('result-leads');

    function updateROI() {
      const jobs = parseInt(slider.value, 10);
      jobsValue.textContent     = jobs;
      resultReviews.textContent = Math.round(jobs * 12 * 0.15);
      resultLeads.textContent   = Math.round(jobs * 12);
    }

    slider.addEventListener('input', updateROI);
    updateROI();
  }

});
