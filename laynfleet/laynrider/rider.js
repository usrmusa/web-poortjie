/**
 * rider.js — LaynFleet Rider Web Client
 *
 * Handles Global Authentication, Profile Gating, Suspension checks,
 * Real-time Online Drivers listener, Transport Category filtering,
 * Quick Ride auto-dispatch, Geofencing, Google Places Autocomplete,
 * Quote Handshake (60s countdown), and Live Trip Tracking.
 *
 * Strict camelCase schema adhering to the Android App source of truth.
 */
(function (global) {
  'use strict';

  // 1. Initialise Firebase instance
  if (!firebase.apps.length) {
    firebase.initializeApp(global.LAYNFLEET_FIREBASE_CONFIG);
  }
  const auth = firebase.auth();
  const db = firebase.firestore();

  const FS = global.FS;
  const SERVICE_AREA = global.SERVICE_AREA || {
    center: { lat: -26.45600, lng: 27.77087 },
    radiusMeters: 1637
  };

  // Collections
  const driversCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.drivers);
  const ridersCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.riders);
  const bookingsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.bookings);
  const usersCol = db.collection(FS.users);

  // State
  let currentUser = null;
  let userProfile = null;
  let isProfileComplete = false;

  let allOnlineDrivers = [];
  let selectedCategory = 'ALL';
  let driverListenersUnsub = null;
  let activeBookingUnsub = null;
  let currentBookingDoc = null;

  let activeDriverModal = null;
  let bookingTargetDriver = null; // null for Quick Ride

  // Timers
  let pendingTimerInterval = null;
  let quoteTimerInterval = null;

  // Rating State
  let selectedStars = 5;

  // Booking Form State
  let bookingState = {
    type: 'ASAP', // 'ASAP' | 'SCHEDULED'
    pickup: {
      address: 'Poortjie Taxi Rank',
      lat: SERVICE_AREA.center.lat,
      lng: SERVICE_AREA.center.lng
    },
    dropoff: {
      address: '',
      lat: -26.48000,
      lng: 27.86000
    },
    note: '',
    vehicleType: 'PRIVATE_CAR',
    scheduledEpoch: null
  };

  // User cache for driver identities
  const userCache = new Map();

  // DOM Elements - App Views
  const bootView = document.getElementById('boot-view');
  const authGateView = document.getElementById('auth-gate-view');
  const suspendedView = document.getElementById('suspended-view');
  const appView = document.getElementById('app-view');

  // Header Elements
  const headerUserBtn = document.getElementById('header-user-btn');
  const headerAvatar = document.getElementById('header-avatar');
  const headerUserName = document.getElementById('header-user-name');
  const headerSignOutBtn = document.getElementById('header-signout-btn');
  const headerSignInBtn = document.getElementById('header-signin-btn');

  // Banners & CTA
  const profileIncompleteBanner = document.getElementById('profile-incomplete-banner');
  const completeProfileBtn = document.getElementById('complete-profile-btn');
  const activeBookingBanner = document.getElementById('active-booking-banner');
  const activeBookingStatusText = document.getElementById('active-booking-status-text');
  const viewActiveBookingBtn = document.getElementById('view-active-booking-btn');
  const quickRideBtn = document.getElementById('quick-ride-btn');

  // Filter Chips & Lists
  const filterChips = document.querySelectorAll('.filter-chip');
  const availableListEl = document.getElementById('available-drivers-list');
  const busyListEl = document.getElementById('busy-drivers-list');
  const availableSectionEl = document.getElementById('section-available');
  const busySectionEl = document.getElementById('section-busy');
  const availableCountEl = document.getElementById('available-count');
  const busyCountEl = document.getElementById('busy-count');
  const emptyDriversView = document.getElementById('empty-drivers-view');

  // Driver Modal Elements
  const driverModal = document.getElementById('driver-modal');
  const driverModalClose = document.getElementById('driver-modal-close');
  const driverModalCancel = document.getElementById('driver-modal-cancel');
  const driverModalSelectBtn = document.getElementById('driver-modal-select-btn');
  const driverModalAvatar = document.getElementById('driver-modal-avatar');
  const driverModalName = document.getElementById('driver-modal-name');
  const driverModalVehicleType = document.getElementById('driver-modal-vehicle-type');
  const driverModalStatus = document.getElementById('driver-modal-status');
  const driverModalRating = document.getElementById('driver-modal-rating');
  const driverModalTrips = document.getElementById('driver-modal-trips');
  const driverModalSeats = document.getElementById('driver-modal-seats');
  const driverModalVehicleDesc = document.getElementById('driver-modal-vehicle-desc');
  const driverModalPlate = document.getElementById('driver-modal-plate');

  // Booking Modal Elements
  const bookingModal = document.getElementById('booking-modal');
  const bookingModalClose = document.getElementById('booking-modal-close');
  const bookingModalCancel = document.getElementById('booking-modal-cancel');
  const bookingForm = document.getElementById('booking-form');
  const bookingSubmitBtn = document.getElementById('booking-submit-btn');
  const bookingTargetTitle = document.getElementById('booking-target-title');
  const bookingTargetSubtitle = document.getElementById('booking-target-subtitle');
  const bookingTargetTypeBadge = document.getElementById('booking-target-type-badge');
  const toggleTypeAsap = document.getElementById('toggle-type-asap');
  const toggleTypeScheduled = document.getElementById('toggle-type-scheduled');
  const scheduledFields = document.getElementById('scheduled-fields');
  const scheduledDateInput = document.getElementById('booking-scheduled-date');
  const scheduledTimeInput = document.getElementById('booking-scheduled-time');
  const pickupAddressInput = document.getElementById('booking-pickup-address');
  const pickupGpsBtn = document.getElementById('pickup-gps-btn');
  const pickupGeofenceBadge = document.getElementById('pickup-geofence-badge');
  const pickupErrorEl = document.getElementById('pickup-error');
  const dropoffAddressInput = document.getElementById('booking-dropoff-address');
  const bookingNoteInput = document.getElementById('booking-note');
  const bookingNoteCount = document.getElementById('booking-note-count');
  const bookingFormError = document.getElementById('booking-form-error');

  // Active Trip / Tracking Modal Elements
  const activeTripModal = document.getElementById('active-trip-modal');
  const activeTripModalClose = document.getElementById('active-trip-modal-close');
  const trackBookingId = document.getElementById('track-booking-id');

  // Stepper Elements
  const stepRequested = document.getElementById('step-requested');
  const stepQuote = document.getElementById('step-quote');
  const stepAccepted = document.getElementById('step-accepted');
  const stepEnroute = document.getElementById('step-enroute');
  const stepTrip = document.getElementById('step-trip');
  const stepCompleted = document.getElementById('step-completed');

  // Trip State Sections
  const trackPendingSection = document.getElementById('track-pending-section');
  const pendingCountdown = document.getElementById('pending-countdown');
  const cancelPendingBtn = document.getElementById('cancel-pending-btn');

  const trackQuotedSection = document.getElementById('track-quoted-section');
  const quotedPriceAmount = document.getElementById('quoted-price-amount');
  const quotedEtaText = document.getElementById('quoted-eta-text');
  const quotedCountdown = document.getElementById('quoted-countdown');
  const approveBtnPrice = document.getElementById('approve-btn-price');
  const approveQuoteBtn = document.getElementById('approve-quote-btn');
  const declineQuoteBtn = document.getElementById('decline-quote-btn');

  const trackActiveSection = document.getElementById('track-active-section');
  const trackStatusIcon = document.getElementById('track-status-icon');
  const trackStatusTitle = document.getElementById('track-status-title');
  const trackStatusDesc = document.getElementById('track-status-desc');
  const trackDriverAvatar = document.getElementById('track-driver-avatar');
  const trackDriverName = document.getElementById('track-driver-name');
  const trackVehicleDesc = document.getElementById('track-vehicle-desc');
  const trackVehiclePlate = document.getElementById('track-vehicle-plate');
  const trackCallBtn = document.getElementById('track-call-btn');
  const trackWhatsappBtn = document.getElementById('track-whatsapp-btn');
  const trackPickupText = document.getElementById('track-pickup-text');
  const trackDropoffText = document.getElementById('track-dropoff-text');
  const trackFareText = document.getElementById('track-fare-text');

  const trackCompletedSection = document.getElementById('track-completed-section');
  const completedFareAmount = document.getElementById('completed-fare-amount');
  const completedDoneBtn = document.getElementById('completed-done-btn');
  const tripReviewComment = document.getElementById('trip-review-comment');
  const ratingStarBtns = document.querySelectorAll('.rating-star-btn');

  const trackCancelledSection = document.getElementById('track-cancelled-section');
  const cancelledTitle = document.getElementById('cancelled-title');
  const cancelledReasonText = document.getElementById('cancelled-reason-text');
  const cancelledDismissBtn = document.getElementById('cancelled-dismiss-btn');

  // Auth Gate Form
  const authEmailForm = document.getElementById('auth-email-form');
  const authEmailInput = document.getElementById('auth-email');
  const authPasswordInput = document.getElementById('auth-password');
  const authSubmitBtn = document.getElementById('auth-submit-btn');
  const authGoogleBtn = document.getElementById('auth-google-btn');
  const authErrorEl = document.getElementById('auth-error');
  const toggleEmailAuthBtn = document.getElementById('toggle-email-auth-btn');
  const emailAuthContainer = document.getElementById('email-auth-container');

  // Toast
  const toastEl = document.getElementById('toast');

  /** Show toast message */
  function showToast(message, duration = 3000) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove('is-hidden');
    setTimeout(() => {
      toastEl.classList.add('is-hidden');
    }, duration);
  }

  /** Navigate user to global profile page */
  function navigateToProfile() {
    sessionStorage.setItem('redirectUrl', window.location.href);
    window.location.href = '../../authentication/profile.html';
  }

  /** Validate phone number: exactly 10 digits */
  function isValidPhone(phone) {
    if (!phone) return false;
    const clean = phone.toString().replace(/\D/g, '');
    return clean.length === 10;
  }

  /** Validate full name: 1 to 3 words */
  function isValidName(name) {
    if (!name) return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 64) return false;
    const parts = trimmed.split(/\s+/);
    return parts.length >= 1 && parts.length <= 3;
  }

  /** Haversine Distance in meters */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /** Geofence Validation: Must be within 1637m of Poortjie center */
  function isPickupAllowed(lat, lng) {
    if (lat == null || lng == null) return false;
    const dist = distanceMeters(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng, lat, lng);
    return dist <= SERVICE_AREA.radiusMeters;
  }

  /** Evaluate profile completeness strictly against Android spec */
  function checkProfileCompleteness(data, authRecord) {
    if (!data) data = {};
    const name = data.displayName || authRecord.displayName || '';
    const phone = data.phone || authRecord.phoneNumber || '';
    const photo = data.photoUrl || authRecord.photoURL || '';

    const nameOk = isValidName(name);
    const phoneOk = isValidPhone(phone);
    const photoOk = Boolean(photo && photo.trim().length > 0);

    return {
      isComplete: nameOk && phoneOk && photoOk,
      name,
      phone,
      photo,
      nameOk,
      phoneOk,
      photoOk
    };
  }

  /** Switch primary UI views */
  function showView(viewName) {
    if (bootView) bootView.classList.add('is-hidden');
    if (authGateView) authGateView.classList.add('is-hidden');
    if (suspendedView) suspendedView.classList.add('is-hidden');
    if (appView) appView.classList.add('is-hidden');

    if (viewName === 'boot') {
      if (bootView) bootView.classList.remove('is-hidden');
    } else if (viewName === 'auth') {
      if (authGateView) authGateView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.remove('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.add('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.add('is-hidden');
    } else if (viewName === 'suspended') {
      if (suspendedView) suspendedView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
    } else if (viewName === 'app') {
      if (appView) appView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
    }
  }

  /** Helper to format transport type labels */
  function formatVehicleType(type) {
    switch (type) {
      case 'PRIVATE_CAR': return 'Private Car';
      case 'MINI_BUS': return 'Mini Bus';
      case 'BAKKIE': return 'Bakkie';
      case 'MOTORBIKE': return 'Motorbike';
      case 'TUKTUK': return 'TukTuk';
      default: return type ? type.replace(/_/g, ' ') : 'Private Car';
    }
  }

  /** Fetch user identity for driver */
  async function getDriverIdentity(uid) {
    if (!uid) return {};
    if (userCache.has(uid)) {
      return userCache.get(uid);
    }
    try {
      const doc = await usersCol.doc(uid).get();
      const data = doc.exists ? doc.data() : {};
      userCache.set(uid, data);
      return data;
    } catch (e) {
      console.warn('Failed to load driver identity for:', uid, e);
      return {};
    }
  }

  /** Fetch driver vehicle & record */
  async function getDriverRecord(uid) {
    if (!uid) return {};
    try {
      const doc = await driversCol.doc(uid).get();
      return doc.exists ? doc.data() : {};
    } catch (e) {
      console.warn('Failed to load driver doc for:', uid, e);
      return {};
    }
  }

  /** ============================================================
   * GOOGLE PLACES SEARCH INTEGRATION
   * ============================================================ */
  global.initGooglePlaces = function () {
    if (!global.google || !global.google.maps || !global.google.maps.places) {
      console.warn('Google Places library not yet ready.');
      return;
    }

    const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
    const circle = new google.maps.Circle({ center: poortjieCenter, radius: 5000 });

    // 1. Pickup Autocomplete (Biased towards Poortjie)
    if (pickupAddressInput) {
      const pickupAutocomplete = new google.maps.places.Autocomplete(pickupAddressInput, {
        bounds: circle.getBounds(),
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      pickupAutocomplete.addListener('place_changed', () => {
        const place = pickupAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || pickupAddressInput.value;
          setPickupLocation(addr, lat, lng);
        }
      });
    }

    // 2. Dropoff Autocomplete (South Africa anywhere)
    if (dropoffAddressInput) {
      const dropoffAutocomplete = new google.maps.places.Autocomplete(dropoffAddressInput, {
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      dropoffAutocomplete.addListener('place_changed', () => {
        const place = dropoffAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || dropoffAddressInput.value;
          bookingState.dropoff = { address: addr, lat, lng };
          dropoffAddressInput.value = addr;
        }
      });
    }
  };

  /** Live listener for online drivers */
  function startDriverListener() {
    if (driverListenersUnsub) {
      driverListenersUnsub();
      driverListenersUnsub = null;
    }

    driverListenersUnsub = driversCol.onSnapshot(async (snapshot) => {
      const drivers = [];

      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        if (data.approvalStatus === 'APPROVED' && data.online === true) {
          const userDoc = await getDriverIdentity(doc.id);
          drivers.push({
            uid: doc.id,
            approvalStatus: data.approvalStatus,
            online: data.online === true,
            busy: data.busy === true,
            ratingAvg: typeof data.ratingAvg === 'number' ? data.ratingAvg : 5.0,
            ratingCount: data.ratingCount || 0,
            tripsCount: data.tripsCount || 0,
            vehicle: data.vehicle || {},
            user: {
              displayName: userDoc.displayName || 'Poortjie Driver',
              photoUrl: userDoc.photoUrl || '',
              phone: userDoc.phone || ''
            }
          });
        }
      }

      allOnlineDrivers = drivers;
      renderDrivers();
    }, (error) => {
      console.error('Error observing online drivers:', error);
      showToast('Error loading online drivers.');
    });
  }

  function stopDriverListener() {
    if (driverListenersUnsub) {
      driverListenersUnsub();
      driverListenersUnsub = null;
    }
  }

  /** Render drivers list partitioned into Available and Busy */
  function renderDrivers() {
    const filtered = allOnlineDrivers.filter((driver) => {
      if (selectedCategory === 'ALL') return true;
      const vType = (driver.vehicle && driver.vehicle.type) ? driver.vehicle.type.toUpperCase() : 'PRIVATE_CAR';
      return vType === selectedCategory;
    });

    const availableDrivers = filtered.filter((d) => !d.busy);
    const busyDrivers = filtered.filter((d) => d.busy);

    if (availableCountEl) availableCountEl.textContent = availableDrivers.length;
    if (busyCountEl) busyCountEl.textContent = busyDrivers.length;

    if (availableListEl) {
      if (availableDrivers.length > 0) {
        availableListEl.innerHTML = availableDrivers.map((d) => createDriverCardHtml(d)).join('');
        if (availableSectionEl) availableSectionEl.classList.remove('is-hidden');
      } else {
        availableListEl.innerHTML = '';
        if (availableSectionEl) availableSectionEl.classList.add('is-hidden');
      }
    }

    if (busyListEl) {
      if (busyDrivers.length > 0) {
        busyListEl.innerHTML = busyDrivers.map((d) => createDriverCardHtml(d)).join('');
        if (busySectionEl) busySectionEl.classList.remove('is-hidden');
      } else {
        busyListEl.innerHTML = '';
        if (busySectionEl) busySectionEl.classList.add('is-hidden');
      }
    }

    if (emptyDriversView) {
      const hasDrivers = availableDrivers.length > 0 || busyDrivers.length > 0;
      emptyDriversView.classList.toggle('is-hidden', hasDrivers);
    }
  }

  /** Generate HTML for a driver card */
  function createDriverCardHtml(driver) {
    const v = driver.vehicle || {};
    const u = driver.user || {};
    const vehicleTypeFormatted = formatVehicleType(v.type);
    const makeModel = `${v.make || 'Vehicle'} ${v.model || ''}`.trim();
    const colour = v.colour ? ` · ${v.colour}` : '';
    const plate = v.plate || 'Verified';
    const seats = v.seats ? `${v.seats} seats` : '4 seats';
    const avatar = u.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.displayName || 'D')}&background=22c55e&color=fff&size=128`;
    const ratingFormatted = driver.ratingAvg ? driver.ratingAvg.toFixed(1) : '5.0';

    return `
      <article class="driver-card ${driver.busy ? 'is-busy' : ''}" data-driver-id="${driver.uid}">
        <div class="driver-card-top">
          <span class="vehicle-type-tag">${vehicleTypeFormatted}</span>
          <span class="driver-status-badge ${driver.busy ? 'badge-busy' : ''}">
            ${driver.busy ? '🟡 Busy' : '🟢 Available'}
          </span>
        </div>

        <div>
          <div class="vehicle-desc">${makeModel}${colour}</div>
          <div class="vehicle-meta">
            <span>💺 ${seats}</span>
            <span>·</span>
            <span>🏷️ ${plate}</span>
          </div>
        </div>

        <div class="driver-profile-row">
          <img class="driver-avatar" src="${avatar}" alt="${u.displayName || 'Driver'}" onerror="this.src='https://placehold.co/80x80/22c55e/ffffff?text=D'" />
          <div class="driver-info">
            <div class="driver-name">${u.displayName || 'Driver'}</div>
            <div class="driver-rating">
              <span class="star">★</span>
              <strong>${ratingFormatted}</strong>
              <span>(${driver.tripsCount || 0} trips)</span>
            </div>
          </div>
        </div>

        <div class="driver-actions">
          <button class="btn btn-sm btn-ghost" onclick="LaynRiderBooking.openDriverModal('${driver.uid}')">
            View Profile
          </button>
          <button class="btn btn-sm ${driver.busy ? 'btn-gold' : 'btn-primary'}" onclick="LaynRiderBooking.openBookingForm('${driver.uid}')">
            Book Ride
          </button>
        </div>
      </article>
    `;
  }

  /** Open Driver Detail Modal */
  function openDriverModal(driverId) {
    const driver = allOnlineDrivers.find((d) => d.uid === driverId);
    if (!driver) return;

    activeDriverModal = driver;
    const v = driver.vehicle || {};
    const u = driver.user || {};

    if (driverModalAvatar) {
      driverModalAvatar.src = u.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.displayName || 'D')}&background=22c55e&color=fff&size=128`;
    }
    if (driverModalName) driverModalName.textContent = u.displayName || 'Poortjie Driver';
    if (driverModalVehicleType) driverModalVehicleType.textContent = formatVehicleType(v.type);
    if (driverModalStatus) {
      driverModalStatus.textContent = driver.busy ? '🟡 Currently on a trip (Queue available)' : '🟢 Available now for pickup';
    }
    if (driverModalRating) driverModalRating.textContent = `★ ${driver.ratingAvg ? driver.ratingAvg.toFixed(1) : '5.0'}`;
    if (driverModalTrips) driverModalTrips.textContent = `${driver.tripsCount || 0}`;
    if (driverModalSeats) driverModalSeats.textContent = `${v.seats || 4} Seats`;
    if (driverModalVehicleDesc) driverModalVehicleDesc.textContent = `${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    if (driverModalPlate) driverModalPlate.textContent = `Plate: ${v.plate || 'Verified'}`;

    if (driverModal) driverModal.classList.remove('is-hidden');
  }

  function closeDriverModal() {
    activeDriverModal = null;
    if (driverModal) driverModal.classList.add('is-hidden');
  }

  /** ============================================================
   * BOOKING FORM & GEOFENCING IMPLEMENTATION
   * ============================================================ */

  /** Open Booking Form */
  function openBookingForm(driverId) {
    if (!isProfileComplete) {
      showToast('Please complete your profile (name, phone & photo) to request a ride.');
      setTimeout(navigateToProfile, 1200);
      return;
    }

    if (currentBookingDoc && ['PENDING', 'QUOTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'].includes(currentBookingDoc.status)) {
      showToast('You already have an active ride in progress.');
      openActiveTripModal();
      return;
    }

    closeDriverModal();

    if (driverId) {
      bookingTargetDriver = allOnlineDrivers.find((d) => d.uid === driverId) || null;
    } else {
      bookingTargetDriver = null; // Quick Ride
    }

    if (bookingTargetDriver) {
      const v = bookingTargetDriver.vehicle || {};
      const u = bookingTargetDriver.user || {};
      if (bookingTargetTitle) bookingTargetTitle.textContent = u.displayName || 'Driver';
      if (bookingTargetSubtitle) bookingTargetSubtitle.textContent = `${v.make || 'Vehicle'} ${v.model || ''} (${v.plate || 'Verified'})`;
      if (bookingTargetTypeBadge) bookingTargetTypeBadge.textContent = formatVehicleType(v.type);
      bookingState.vehicleType = v.type || 'PRIVATE_CAR';
    } else {
      if (bookingTargetTitle) bookingTargetTitle.textContent = 'Quick Ride Auto-Dispatch';
      if (bookingTargetSubtitle) bookingTargetSubtitle.textContent = 'Nearest available Private Car in Poortjie';
      if (bookingTargetTypeBadge) bookingTargetTypeBadge.textContent = 'Private Car';
      bookingState.vehicleType = 'PRIVATE_CAR';
    }

    setBookingType('ASAP');
    setPickupLocation('Poortjie Taxi Rank', SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
    if (dropoffAddressInput) dropoffAddressInput.value = bookingState.dropoff.address || '';
    if (bookingNoteInput) bookingNoteInput.value = '';
    if (bookingNoteCount) bookingNoteCount.textContent = '0/64';
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    if (bookingModal) bookingModal.classList.remove('is-hidden');
  }

  function closeBookingModal() {
    if (bookingModal) bookingModal.classList.add('is-hidden');
  }

  /** Set Booking Type (ASAP or SCHEDULED) */
  function setBookingType(type) {
    bookingState.type = type;
    if (type === 'ASAP') {
      if (toggleTypeAsap) toggleTypeAsap.classList.add('is-active');
      if (toggleTypeScheduled) toggleTypeScheduled.classList.remove('is-active');
      if (scheduledFields) scheduledFields.classList.add('is-hidden');
    } else {
      if (toggleTypeAsap) toggleTypeAsap.classList.remove('is-active');
      if (toggleTypeScheduled) toggleTypeScheduled.classList.add('is-active');
      if (scheduledFields) scheduledFields.classList.remove('is-hidden');

      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      if (scheduledDateInput && !scheduledDateInput.value) {
        scheduledDateInput.value = tomorrow.toISOString().split('T')[0];
        scheduledDateInput.min = today.toISOString().split('T')[0];
      }
      if (scheduledTimeInput && !scheduledTimeInput.value) {
        const hh = String(today.getHours()).padStart(2, '0');
        const mm = String(today.getMinutes()).padStart(2, '0');
        scheduledTimeInput.value = `${hh}:${mm}`;
      }
    }
  }

  /** Update pickup coordinates and validate geofence */
  function setPickupLocation(address, lat, lng) {
    bookingState.pickup = { address: address.trim(), lat, lng };
    if (pickupAddressInput) pickupAddressInput.value = address;
    validatePickupGeofence();
  }

  /** Validate Pickup Geofence */
  function validatePickupGeofence() {
    const lat = bookingState.pickup.lat;
    const lng = bookingState.pickup.lng;
    const allowed = isPickupAllowed(lat, lng);

    if (pickupGeofenceBadge) {
      if (allowed) {
        pickupGeofenceBadge.className = 'geofence-badge is-valid';
        pickupGeofenceBadge.textContent = '🟢 Inside Poortjie';
      } else {
        pickupGeofenceBadge.className = 'geofence-badge is-invalid';
        pickupGeofenceBadge.textContent = '🔴 Outside Service Area';
      }
    }

    if (pickupErrorEl) {
      if (!allowed) {
        pickupErrorEl.textContent = 'Pickup must be inside Poortjie (within 1.64 km of town center).';
        pickupErrorEl.classList.remove('is-hidden');
      } else {
        pickupErrorEl.classList.add('is-hidden');
      }
    }

    return allowed;
  }

  /** Get GPS Current Position */
  function getGpsLocation() {
    if (!navigator.geolocation) {
      showToast('Geolocation is not supported by your browser.');
      return;
    }

    if (pickupGpsBtn) {
      pickupGpsBtn.disabled = true;
      pickupGpsBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;"></div> GPS';
    }

    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const allowed = isPickupAllowed(lat, lng);

      if (allowed) {
        setPickupLocation('Current GPS Location (Poortjie)', lat, lng);
        showToast('GPS location within Poortjie captured!');
      } else {
        setPickupLocation('Current GPS Location (Outside Area)', lat, lng);
        showToast('Your GPS location is outside the Poortjie service area.');
      }

      if (pickupGpsBtn) {
        pickupGpsBtn.disabled = false;
        pickupGpsBtn.innerHTML = '<span>📍</span> GPS';
      }
    }, (err) => {
      console.warn('Geolocation error:', err);
      showToast('Could not retrieve GPS location. Search an address.');
      if (pickupGpsBtn) {
        pickupGpsBtn.disabled = false;
        pickupGpsBtn.innerHTML = '<span>📍</span> GPS';
      }
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  /** Submit Booking */
  async function handleBookingSubmit(e) {
    if (e) e.preventDefault();
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    if (!currentUser) {
      showToast('Please sign in to book a ride.');
      return;
    }

    if (!isProfileComplete) {
      showToast('Full name, 10-digit phone, and photo are required.');
      navigateToProfile();
      return;
    }

    const pickupAddress = pickupAddressInput ? pickupAddressInput.value.trim() : '';
    if (!pickupAddress) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Please specify a pickup location.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.pickup.address = pickupAddress;

    if (!validatePickupGeofence()) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Pickup must be inside Poortjie service area.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }

    const dropoffAddress = dropoffAddressInput ? dropoffAddressInput.value.trim() : '';
    if (!dropoffAddress) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Please enter a drop-off destination.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.dropoff.address = dropoffAddress;

    let scheduledEpochMillis = null;
    if (bookingState.type === 'SCHEDULED') {
      const d = scheduledDateInput ? scheduledDateInput.value : '';
      const t = scheduledTimeInput ? scheduledTimeInput.value : '';
      if (!d || !t) {
        if (bookingFormError) {
          bookingFormError.textContent = 'Please provide both date and time for scheduled ride.';
          bookingFormError.classList.remove('is-hidden');
        }
        return;
      }
      const schedDate = new Date(`${d}T${t}`);
      scheduledEpochMillis = schedDate.getTime();
      if (isNaN(scheduledEpochMillis) || scheduledEpochMillis < Date.now()) {
        if (bookingFormError) {
          bookingFormError.textContent = 'Scheduled time must be in the future.';
          bookingFormError.classList.remove('is-hidden');
        }
        return;
      }
    }

    const note = bookingNoteInput ? bookingNoteInput.value.trim() : '';

    try {
      if (bookingSubmitBtn) {
        bookingSubmitBtn.disabled = true;
        bookingSubmitBtn.innerHTML = '<div class="spinner"></div> Dispatching…';
      }

      const now = Date.now();
      const riderUidPrefix = currentUser.uid.substring(0, 6);
      const bookingId = `b_${now}_${riderUidPrefix}`;

      const requestedDriverId = bookingTargetDriver ? bookingTargetDriver.uid : null;
      const initialDetail = requestedDriverId
        ? `Requested specific driver: ${requestedDriverId}`
        : 'Quick Ride auto-dispatch';

      const initialEvent = {
        event: 'DISPATCHED',
        actorUid: currentUser.uid,
        detail: initialDetail,
        timestamp: now
      };

      const bookingDocData = {
        id: bookingId,
        riderId: currentUser.uid,
        type: bookingState.type,
        pickup: {
          address: bookingState.pickup.address,
          lat: bookingState.pickup.lat,
          lng: bookingState.pickup.lng
        },
        dropoff: {
          address: bookingState.dropoff.address,
          lat: bookingState.dropoff.lat,
          lng: bookingState.dropoff.lng
        },
        note: note,
        vehicleType: bookingState.vehicleType,
        scheduledTime: scheduledEpochMillis,
        status: 'PENDING',
        driverId: null,
        requestedDriverId: requestedDriverId,
        deliveredAt: null,
        quotedPrice: null,
        availabilityEtaMinutes: null,
        priceApproved: false,
        cancelReason: '',
        cancelledByDriver: false,
        events: [initialEvent],
        createdAt: now,
        updatedAt: now
      };

      await bookingsCol.doc(bookingId).set(bookingDocData);

      await ridersCol.doc(currentUser.uid).set({
        uid: currentUser.uid,
        lastRequestedAt: now
      }, { merge: true });

      closeBookingModal();
      showToast('Ride requested! Opening live tracking…');
      openActiveTripModal();
    } catch (err) {
      console.error('Failed to create booking:', err);
      if (bookingFormError) {
        bookingFormError.textContent = 'Failed to create ride request. Please try again.';
        bookingFormError.classList.remove('is-hidden');
      }
    } finally {
      if (bookingSubmitBtn) {
        bookingSubmitBtn.disabled = false;
        bookingSubmitBtn.textContent = 'Request Ride';
      }
    }
  }

  /** ============================================================
   * LIVE QUOTE HANDSHAKE & TRIP TRACKING SCREEN
   * ============================================================ */

  /** Open / Close Active Trip Modal */
  function openActiveTripModal() {
    if (activeTripModal) activeTripModal.classList.remove('is-hidden');
    if (currentBookingDoc) renderActiveTripDetails(currentBookingDoc);
  }

  function closeActiveTripModal() {
    if (activeTripModal) activeTripModal.classList.add('is-hidden');
  }

  /** Start Live Active Booking Listener */
  function startActiveBookingListener(riderUid) {
    if (activeBookingUnsub) {
      activeBookingUnsub();
      activeBookingUnsub = null;
    }

    activeBookingUnsub = bookingsCol
      .where('riderId', '==', riderUid)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .onSnapshot(async (snap) => {
        if (!snap.empty) {
          const doc = snap.docs[0];
          const data = { id: doc.id, ...doc.data() };
          currentBookingDoc = data;

          const isActive = ['PENDING', 'QUOTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'].includes(data.status);

          if (activeBookingBanner) {
            activeBookingBanner.classList.toggle('is-hidden', !isActive);
            if (activeBookingStatusText) {
              activeBookingStatusText.textContent = `Status: ${formatBookingStatus(data.status)}`;
            }
          }

          if (activeTripModal && !activeTripModal.classList.contains('is-hidden')) {
            await renderActiveTripDetails(data);
          }
        } else {
          currentBookingDoc = null;
          if (activeBookingBanner) activeBookingBanner.classList.add('is-hidden');
          closeActiveTripModal();
        }
      }, (err) => {
        console.error('Error listening to active bookings:', err);
      });
  }

  /** Render Trip Tracking Details according to status */
  async function renderActiveTripDetails(booking) {
    if (!booking) return;

    if (trackBookingId) trackBookingId.textContent = `#${booking.id}`;

    // Reset all sections
    if (trackPendingSection) trackPendingSection.classList.add('is-hidden');
    if (trackQuotedSection) trackQuotedSection.classList.add('is-hidden');
    if (trackActiveSection) trackActiveSection.classList.add('is-hidden');
    if (trackCompletedSection) trackCompletedSection.classList.add('is-hidden');
    if (trackCancelledSection) trackCancelledSection.classList.add('is-hidden');

    // Clear timers
    if (pendingTimerInterval) { clearInterval(pendingTimerInterval); pendingTimerInterval = null; }
    if (quoteTimerInterval) { clearInterval(quoteTimerInterval); quoteTimerInterval = null; }

    // Update Stepper
    updateTrackingStepper(booking.status);

    const status = booking.status || 'PENDING';

    if (status === 'PENDING') {
      // 1. Pending Section (60s countdown timer)
      if (trackPendingSection) trackPendingSection.classList.remove('is-hidden');
      startPendingCountdown(booking);
    } else if (status === 'QUOTED') {
      // 2. Quote Handshake (60s countdown timer)
      if (trackQuotedSection) trackQuotedSection.classList.remove('is-hidden');
      const price = typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '0.00';
      if (quotedPriceAmount) quotedPriceAmount.textContent = `R ${price}`;
      if (approveBtnPrice) approveBtnPrice.textContent = price;
      if (quotedEtaText) {
        quotedEtaText.textContent = `Est. Pickup ETA: ~${booking.availabilityEtaMinutes || 5} mins`;
      }
      startQuoteCountdown(booking);
    } else if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'].includes(status)) {
      // 3. Active En Route / Arrived / In Trip Section
      if (trackActiveSection) trackActiveSection.classList.remove('is-hidden');
      await renderDriverInfoForTracking(booking);
    } else if (status === 'COMPLETED') {
      // 4. Completed Section
      if (trackCompletedSection) trackCompletedSection.classList.remove('is-hidden');
      const finalFare = typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '0.00';
      if (completedFareAmount) completedFareAmount.textContent = `R ${finalFare}`;
    } else {
      // 5. Terminal Cancelled / Expired / No Driver
      if (trackCancelledSection) trackCancelledSection.classList.remove('is-hidden');
      if (cancelledTitle) {
        if (status === 'CANCELLED_NO_DRIVER' || status === 'DRIVER_UNAVAILABLE') {
          cancelledTitle.textContent = 'No Drivers Available';
        } else if (status === 'CANCELLED_EXPIRED') {
          cancelledTitle.textContent = 'Quote Expired';
        } else {
          cancelledTitle.textContent = 'Ride Cancelled';
        }
      }
      if (cancelledReasonText) {
        cancelledReasonText.textContent = booking.cancelReason || 'Request ended without confirmation.';
      }
    }
  }

  /** Update Stepper nodes */
  function updateTrackingStepper(status) {
    const steps = [
      { el: stepRequested, target: 'PENDING' },
      { el: stepQuote, target: 'QUOTED' },
      { el: stepAccepted, target: 'ACCEPTED' },
      { el: stepEnroute, target: 'EN_ROUTE' },
      { el: stepTrip, target: 'IN_TRIP' },
      { el: stepCompleted, target: 'COMPLETED' }
    ];

    const order = ['PENDING', 'QUOTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'COMPLETED'];
    const currentIdx = order.indexOf(status === 'ARRIVED' ? 'EN_ROUTE' : status);

    steps.forEach((step, idx) => {
      if (!step.el) return;
      step.el.classList.remove('is-active', 'is-done');
      if (idx < currentIdx) {
        step.el.classList.add('is-done');
      } else if (idx === currentIdx) {
        step.el.classList.add('is-active');
      }
    });
  }

  /** 60s Pending Countdown Timer */
  function startPendingCountdown(booking) {
    const totalDuration = booking.type === 'SCHEDULED' ? 600 : 60; // 60s ASAP, 10m Scheduled
    const createdAt = booking.createdAt || Date.now();

    function update() {
      const elapsed = Math.floor((Date.now() - createdAt) / 1000);
      const remaining = Math.max(0, totalDuration - elapsed);

      if (pendingCountdown) {
        pendingCountdown.textContent = `${remaining}s`;
      }

      if (remaining <= 0) {
        clearInterval(pendingTimerInterval);
        pendingTimerInterval = null;
        // Auto expire if still PENDING
        if (currentBookingDoc && currentBookingDoc.id === booking.id && currentBookingDoc.status === 'PENDING') {
          bookingsCol.doc(booking.id).update({
            status: 'CANCELLED_NO_DRIVER',
            cancelReason: 'No drivers available within 60s.',
            updatedAt: Date.now()
          });
        }
      }
    }

    update();
    pendingTimerInterval = setInterval(update, 1000);
  }

  /** 60s Quote Countdown Timer */
  function startQuoteCountdown(booking) {
    const quoteReceivedAt = booking.updatedAt || Date.now();
    const duration = 60;

    function update() {
      const elapsed = Math.floor((Date.now() - quoteReceivedAt) / 1000);
      const remaining = Math.max(0, duration - elapsed);

      if (quotedCountdown) {
        quotedCountdown.textContent = `${remaining}s`;
      }

      if (remaining <= 0) {
        clearInterval(quoteTimerInterval);
        quoteTimerInterval = null;
        if (currentBookingDoc && currentBookingDoc.id === booking.id && currentBookingDoc.status === 'QUOTED') {
          bookingsCol.doc(booking.id).update({
            status: 'CANCELLED_EXPIRED',
            cancelReason: 'Rider quote approval timed out after 60s.',
            updatedAt: Date.now()
          });
        }
      }
    }

    update();
    quoteTimerInterval = setInterval(update, 1000);
  }

  /** Render Driver Identity on Active Trip */
  async function renderDriverInfoForTracking(booking) {
    const driverUid = booking.driverId || booking.requestedDriverId;
    const userDoc = await getDriverIdentity(driverUid);
    const driverDoc = await getDriverRecord(driverUid);

    const v = driverDoc.vehicle || {};
    const name = userDoc.displayName || 'Poortjie Driver';
    const phone = userDoc.phone || '';
    const avatar = userDoc.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=22c55e&color=fff&size=128`;

    if (trackDriverAvatar) trackDriverAvatar.src = avatar;
    if (trackDriverName) trackDriverName.textContent = name;
    if (trackVehicleDesc) {
      trackVehicleDesc.textContent = `${formatVehicleType(booking.vehicleType)} · ${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    }
    if (trackVehiclePlate) trackVehiclePlate.textContent = v.plate || 'Verified';

    // Direct Contacts
    if (trackCallBtn) {
      trackCallBtn.href = phone ? `tel:${phone}` : '#';
      trackCallBtn.classList.toggle('is-hidden', !phone);
    }
    if (trackWhatsappBtn) {
      const cleanPhone = phone.startsWith('0') ? '27' + phone.substring(1) : phone;
      trackWhatsappBtn.href = phone ? `https://wa.me/${cleanPhone}?text=Hello%20${encodeURIComponent(name)}%2C%20this%20is%20your%20LaynFleet%20rider.` : '#';
      trackWhatsappBtn.classList.toggle('is-hidden', !phone);
    }

    // Dynamic banner text
    if (trackStatusIcon && trackStatusTitle && trackStatusDesc) {
      if (booking.status === 'ACCEPTED') {
        trackStatusIcon.textContent = '✅';
        trackStatusTitle.textContent = 'Driver Accepted';
        trackStatusDesc.textContent = `${name} is preparing to head your way.`;
      } else if (booking.status === 'EN_ROUTE') {
        trackStatusIcon.textContent = '🚗';
        trackStatusTitle.textContent = 'Driver is En Route';
        trackStatusDesc.textContent = `${name} is on the way to pickup.`;
      } else if (booking.status === 'ARRIVED') {
        trackStatusIcon.textContent = '📍';
        trackStatusTitle.textContent = 'Driver has Arrived!';
        trackStatusDesc.textContent = `Please meet ${name} at your pickup location.`;
      } else if (booking.status === 'IN_TRIP') {
        trackStatusIcon.textContent = '🚀';
        trackStatusTitle.textContent = 'Trip in Progress';
        trackStatusDesc.textContent = 'Headed safely to your drop-off destination.';
      }
    }

    if (trackPickupText) trackPickupText.textContent = booking.pickup?.address || 'Poortjie';
    if (trackDropoffText) trackDropoffText.textContent = booking.dropoff?.address || 'Destination';
    if (trackFareText) {
      const price = typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '0.00';
      trackFareText.textContent = `💵 Agreed Fare: R ${price} (Pay driver offline)`;
    }
  }

  /** Cancel Pending Request */
  async function handleCancelPending() {
    if (!currentBookingDoc) return;
    try {
      if (cancelPendingBtn) cancelPendingBtn.disabled = true;
      const now = Date.now();
      await bookingsCol.doc(currentBookingDoc.id).update({
        status: 'CANCELLED',
        cancelReason: 'Cancelled by rider before dispatch confirmation.',
        updatedAt: now,
        events: firebase.firestore.FieldValue.arrayUnion({
          event: 'CANCELLED_BY_RIDER',
          actorUid: currentUser.uid,
          detail: 'Rider cancelled request',
          timestamp: now
        })
      });
      showToast('Ride request cancelled.');
    } catch (err) {
      console.error('Failed to cancel ride:', err);
      showToast('Could not cancel ride.');
    } finally {
      if (cancelPendingBtn) cancelPendingBtn.disabled = false;
    }
  }

  /** Approve Quote */
  async function handleApproveQuote() {
    if (!currentBookingDoc) return;
    try {
      if (approveQuoteBtn) approveQuoteBtn.disabled = true;
      const now = Date.now();
      await bookingsCol.doc(currentBookingDoc.id).update({
        status: 'ACCEPTED',
        priceApproved: true,
        updatedAt: now,
        events: firebase.firestore.FieldValue.arrayUnion({
          event: 'PRICE_APPROVED',
          actorUid: currentUser.uid,
          detail: `Rider approved quote of R ${currentBookingDoc.quotedPrice}`,
          timestamp: now
        })
      });
      showToast('Quote approved! Driver confirmed.');
    } catch (err) {
      console.error('Failed to approve quote:', err);
      showToast('Could not approve quote. Please try again.');
    } finally {
      if (approveQuoteBtn) approveQuoteBtn.disabled = false;
    }
  }

  /** Decline Quote */
  async function handleDeclineQuote() {
    if (!currentBookingDoc) return;
    try {
      if (declineQuoteBtn) declineQuoteBtn.disabled = true;
      const now = Date.now();
      await bookingsCol.doc(currentBookingDoc.id).update({
        status: 'CANCELLED',
        cancelReason: 'Rider declined driver price quote.',
        updatedAt: now,
        events: firebase.firestore.FieldValue.arrayUnion({
          event: 'CANCELLED_BY_RIDER',
          actorUid: currentUser.uid,
          detail: 'Rider declined quote',
          timestamp: now
        })
      });
      showToast('Quote declined. Request cancelled.');
    } catch (err) {
      console.error('Failed to decline quote:', err);
      showToast('Could not decline quote.');
    } finally {
      if (declineQuoteBtn) declineQuoteBtn.disabled = false;
    }
  }

  /** Submit Rating and Done */
  async function handleCompletedDone() {
    if (completedDoneBtn) completedDoneBtn.disabled = true;
    showToast('Thank you for your rating!');
    setTimeout(() => {
      if (completedDoneBtn) completedDoneBtn.disabled = false;
      closeActiveTripModal();
    }, 1000);
  }

  /** Render user state */
  function renderUserState(authUser, profileData) {
    if (!authUser) {
      currentUser = null;
      userProfile = null;
      isProfileComplete = false;
      stopDriverListener();
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      showView('auth');
      return;
    }

    currentUser = authUser;
    userProfile = profileData || {};

    if (userProfile.suspended === true) {
      const reasonEl = document.getElementById('suspended-reason-text');
      if (reasonEl) {
        reasonEl.textContent = userProfile.suspendedReason || 'Account suspended by management.';
      }
      stopDriverListener();
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      showView('suspended');
      return;
    }

    const completeness = checkProfileCompleteness(userProfile, authUser);
    isProfileComplete = completeness.isComplete;

    const displayName = completeness.name || authUser.email || 'Rider';
    if (headerUserName) headerUserName.textContent = displayName.split(' ')[0];
    if (headerAvatar) {
      if (completeness.photo) {
        headerAvatar.src = completeness.photo;
        headerAvatar.classList.remove('is-hidden');
      } else {
        headerAvatar.src = 'https://placehold.co/100x100/22c55e/ffffff?text=' + encodeURIComponent(displayName[0] || 'R');
      }
    }

    if (profileIncompleteBanner) {
      profileIncompleteBanner.classList.toggle('is-hidden', isProfileComplete);
    }

    showView('app');
    startDriverListener();
    startActiveBookingListener(authUser.uid);
  }

  /** Email/Password sign in */
  async function handleEmailSignIn(e) {
    if (e) e.preventDefault();
    if (authErrorEl) authErrorEl.classList.add('is-hidden');

    const email = authEmailInput ? authEmailInput.value.trim() : '';
    const password = authPasswordInput ? authPasswordInput.value : '';

    if (!email || !password) {
      if (authErrorEl) {
        authErrorEl.textContent = 'Please enter both email and password.';
        authErrorEl.classList.remove('is-hidden');
      }
      return;
    }

    try {
      if (authSubmitBtn) {
        authSubmitBtn.disabled = true;
        authSubmitBtn.innerHTML = '<div class="spinner"></div> Signing in…';
      }

      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      console.error('Sign in error:', err);
      if (authErrorEl) {
        let msg = 'Failed to sign in. Please check your credentials.';
        if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-login-credentials') {
          msg = 'Invalid email or password.';
        } else if (err.code === 'auth/too-many-requests') {
          msg = 'Too many attempts. Please try again later.';
        }
        authErrorEl.textContent = msg;
        authErrorEl.classList.remove('is-hidden');
      }
    } finally {
      if (authSubmitBtn) {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = 'Sign in';
      }
    }
  }

  /** Google Sign-In */
  async function handleGoogleSignIn() {
    if (authErrorEl) authErrorEl.classList.add('is-hidden');
    const provider = new firebase.auth.GoogleAuthProvider();

    try {
      if (authGoogleBtn) {
        authGoogleBtn.disabled = true;
      }
      await auth.signInWithPopup(provider);
    } catch (err) {
      console.warn('Popup sign in failed, trying redirect:', err);
      try {
        await auth.signInWithRedirect(provider);
      } catch (redirectErr) {
        console.error('Google sign in failed:', redirectErr);
        if (authErrorEl) {
          authErrorEl.textContent = 'Google sign-in could not be completed. Please try with email/password.';
          authErrorEl.classList.remove('is-hidden');
        }
      }
    } finally {
      if (authGoogleBtn) {
        authGoogleBtn.disabled = false;
      }
    }
  }

  /** Sign Out */
  async function handleSignOut() {
    try {
      stopDriverListener();
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      await auth.signOut();
      showToast('Signed out');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }

  /** Event Listeners */
  function initListeners() {
    if (authEmailForm) authEmailForm.addEventListener('submit', handleEmailSignIn);
    if (authGoogleBtn) authGoogleBtn.addEventListener('click', handleGoogleSignIn);
    if (headerSignOutBtn) headerSignOutBtn.addEventListener('click', handleSignOut);
    const suspendedSignOutBtn = document.getElementById('suspended-signout-btn');
    if (suspendedSignOutBtn) suspendedSignOutBtn.addEventListener('click', handleSignOut);

    if (toggleEmailAuthBtn && emailAuthContainer) {
      toggleEmailAuthBtn.addEventListener('click', () => {
        emailAuthContainer.classList.toggle('is-hidden');
      });
    }

    if (completeProfileBtn) completeProfileBtn.addEventListener('click', navigateToProfile);
    if (headerUserBtn) headerUserBtn.addEventListener('click', navigateToProfile);

    // Quick Ride
    if (quickRideBtn) quickRideBtn.addEventListener('click', () => openBookingForm(null));

    // Filter Chips
    filterChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        filterChips.forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        selectedCategory = chip.getAttribute('data-type') || 'ALL';
        renderDrivers();
      });
    });

    // Driver Modal
    if (driverModalClose) driverModalClose.addEventListener('click', closeDriverModal);
    if (driverModalCancel) driverModalCancel.addEventListener('click', closeDriverModal);
    if (driverModalSelectBtn) {
      driverModalSelectBtn.addEventListener('click', () => {
        if (activeDriverModal) {
          openBookingForm(activeDriverModal.uid);
        }
      });
    }

    // Booking Modal
    if (bookingModalClose) bookingModalClose.addEventListener('click', closeBookingModal);
    if (bookingModalCancel) bookingModalCancel.addEventListener('click', closeBookingModal);
    if (bookingForm) bookingForm.addEventListener('submit', handleBookingSubmit);

    // Ride Type Toggles
    if (toggleTypeAsap) toggleTypeAsap.addEventListener('click', () => setBookingType('ASAP'));
    if (toggleTypeScheduled) toggleTypeScheduled.addEventListener('click', () => setBookingType('SCHEDULED'));

    // GPS Pickup
    if (pickupGpsBtn) pickupGpsBtn.addEventListener('click', getGpsLocation);

    // Pickup input manual change
    if (pickupAddressInput) {
      pickupAddressInput.addEventListener('input', () => {
        bookingState.pickup.address = pickupAddressInput.value;
        validatePickupGeofence();
      });
    }

    // Dropoff input manual change
    if (dropoffAddressInput) {
      dropoffAddressInput.addEventListener('input', () => {
        bookingState.dropoff.address = dropoffAddressInput.value;
      });
    }

    // Note counter
    if (bookingNoteInput) {
      bookingNoteInput.addEventListener('input', () => {
        if (bookingNoteCount) bookingNoteCount.textContent = `${bookingNoteInput.value.length}/64`;
      });
    }

    // Active Trip Modal
    if (viewActiveBookingBtn) viewActiveBookingBtn.addEventListener('click', openActiveTripModal);
    if (activeTripModalClose) activeTripModalClose.addEventListener('click', closeActiveTripModal);
    if (cancelPendingBtn) cancelPendingBtn.addEventListener('click', handleCancelPending);
    if (approveQuoteBtn) approveQuoteBtn.addEventListener('click', handleApproveQuote);
    if (declineQuoteBtn) declineQuoteBtn.addEventListener('click', handleDeclineQuote);
    if (completedDoneBtn) completedDoneBtn.addEventListener('click', handleCompletedDone);
    if (cancelledDismissBtn) cancelledDismissBtn.addEventListener('click', closeActiveTripModal);

    // Rating star selectors
    ratingStarBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const starVal = parseInt(btn.getAttribute('data-star') || '5', 10);
        selectedStars = starVal;
        ratingStarBtns.forEach((b) => {
          const val = parseInt(b.getAttribute('data-star') || '0', 10);
          b.classList.toggle('is-starred', val <= starVal);
        });
      });
    });
  }

  /** Main App Boot */
  function boot() {
    initListeners();

    auth.onAuthStateChanged(async (authUser) => {
      if (!authUser) {
        renderUserState(null, null);
        return;
      }

      try {
        const userDocRef = db.collection(FS.users).doc(authUser.uid);
        const doc = await userDocRef.get();

        let data = doc.exists ? doc.data() : {};

        if (!doc.exists) {
          data = {
            email: authUser.email || '',
            displayName: authUser.displayName || '',
            photoUrl: authUser.photoURL || '',
            phone: authUser.phoneNumber || '',
            registeredWith: global.APP_PACKAGE,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          await userDocRef.set(data, { merge: true });
        }

        renderUserState(authUser, data);
      } catch (err) {
        console.error('Failed to load user profile doc:', err);
        renderUserState(authUser, {});
      }
    });
  }

  // Expose API
  global.LaynRiderBooking = {
    getCurrentUser: () => currentUser,
    getUserProfile: () => userProfile,
    isProfileComplete: () => isProfileComplete,
    openDriverModal,
    openBookingForm,
    openActiveTripModal,
    navigateToProfile,
    signOut: handleSignOut
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
