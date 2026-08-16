/**
 * rider.js — LaynFleet Rider Web Client
 *
 * Handles Global Authentication, Profile Gating, Suspension checks,
 * Real-time Online Drivers listener, Transport Category filtering,
 * Quick Ride auto-dispatch, Geofencing, Google Places Autocomplete,
 * Quote Handshake (with Driver Identity & 60s countdown), and Live Trip Tracking.
 *
 * Strict camelCase schema adhering to the Android App source of truth.
 */
(function (global) {
  'use strict';

  // 1. Firebase instances initialized globally from scripts/firebase.js
  const auth = global.auth || firebase.auth();
  const db = global.db || firebase.firestore();
  const functions = global.functions || firebase.app().functions(global.FUNCTIONS_REGION || 'us-central1');
  const rtdb = global.rtdb || firebase.database();
  const storage = global.storage || firebase.storage();

  const FS = global.FS || {
    users: 'users',
    laynfleet: 'laynfleet',
    laynfleetDoc: 'main',
    drivers: 'drivers',
    riders: 'riders',
    bookings: 'bookings',
    ratings: 'ratings'
  };
  const RTDB_LOCATIONS = global.RTDB_LOCATIONS || 'driverLocations';
  const HEARTBEAT_FRESHNESS_WINDOW_MS = global.HEARTBEAT_FRESHNESS_WINDOW_MS || 60000;
  const SERVICE_AREA = global.SERVICE_AREA || {
    center: { lat: -26.45600, lng: 27.77087 },
    radiusMeters: 1637
  };

  /**
   * Invoke a dispatch Cloud Function callable (server-authoritative). Mirrors
   * DispatchGateway.call() on Android. Never mutate booking status directly.
   */
  async function callFn(name, payload) {
    const callable = functions.httpsCallable(name);
    const res = await callable(payload || {});
    return res && res.data;
  }

  /** Reads an epoch-millis field stored as a Firestore Timestamp or a Long. */
  function readEpochMillis(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    return null;
  }

  // Collections
  const driversCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.drivers);
  const ridersCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.riders);
  const bookingsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.bookings);
  const ratingsCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.ratings || 'ratings');
  const reviewLikesCol = db.collection(FS.laynfleet).doc(FS.laynfleetDoc).collection(FS.reviewLikes || 'reviewLikes');
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
      address: '',
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

  // User cache for driver identities & reviews
  const userCache = new Map();
  const driverReviewsCache = new Map();

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

  // Dashboard Banners & CTA
  const profileIncompleteBanner = document.getElementById('profile-incomplete-banner');
  const completeProfileBtn = document.getElementById('complete-profile-btn');
  const activeBookingBanner = document.getElementById('active-booking-banner');
  const activeBookingIcon = document.getElementById('active-booking-icon');
  const activeBookingTitle = document.getElementById('active-booking-title');
  const activeBookingCountdownPill = document.getElementById('active-booking-countdown-pill');
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
  const driverModalReviewsList = document.getElementById('driver-modal-reviews-list');

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
  const quotedDriverAvatar = document.getElementById('quoted-driver-avatar');
  const quotedDriverName = document.getElementById('quoted-driver-name');
  const quotedDriverRating = document.getElementById('quoted-driver-rating');
  const quotedDriverVehicle = document.getElementById('quoted-driver-vehicle');
  const quotedDriverPlate = document.getElementById('quoted-driver-plate');
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

  // Toast
  const toastEl = document.getElementById('toast');

  // Profile Completion Modal
  const profileModal = document.getElementById('profile-modal');
  const profileModalClose = document.getElementById('profile-modal-close');
  const profileAvatarRing = document.getElementById('profile-avatar-ring');
  const profileAvatarPreview = document.getElementById('profile-avatar-preview');
  const profilePhotoInput = document.getElementById('profile-photo-input');
  const profilePhotoHint = document.getElementById('profile-photo-hint');
  const profileNameInput = document.getElementById('profile-name-input');
  const profilePhoneInput = document.getElementById('profile-phone-input');
  const profileNameField = document.getElementById('field-name');
  const profilePhoneField = document.getElementById('field-phone');
  const profileModalError = document.getElementById('profile-modal-error');
  const profileSaveBtn = document.getElementById('profile-save-btn');
  const heroNameEl = document.getElementById('hero-name');
  const checkNameEl = document.getElementById('check-name');
  const checkPhoneEl = document.getElementById('check-phone');
  const checkPhotoEl = document.getElementById('check-photo');

  // Profile completion working state
  let selectedProfilePhotoFile = null;
  let pendingBookingDriverId = undefined; // undefined = none; null = Quick Ride; string = specific driver

  /** Web Audio Chime Notification on Quote Received */
  function playQuoteChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (idx + 1) * 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.08);
        osc.stop(ctx.currentTime + (idx + 1) * 0.14 + 0.1);
      });
    } catch (e) {
      console.warn('Audio chime playback:', e);
    }
  }

  /** Format Countdown Timer Text (Android spec: X m Y s or X s) */
  function formatTimerSeconds(seconds) {
    if (seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) {
      return `${m}m ${s}s`;
    }
    return `${s}s`;
  }

  /** Show toast message */
  function showToast(message, duration = 3500) {
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

  /** ============================================================
   * INLINE PROFILE COMPLETION (fill missing details to request)
   * ============================================================ */

  /** Reflect completeness onto the dashboard checklist + hero greeting. */
  function updateProfileChecklist(completeness) {
    const setDone = (el, done) => {
      if (!el) return;
      el.classList.toggle('is-done', !!done);
    };
    setDone(checkNameEl, completeness.nameOk);
    setDone(checkPhoneEl, completeness.phoneOk);
    setDone(checkPhotoEl, completeness.photoOk);
  }

  /**
   * Open the inline completion modal. `resumeDriverId` remembers what the rider
   * was trying to book (null = Quick Ride, string = specific driver) so we can
   * continue straight into booking once the profile is valid.
   */
  function openProfileModal(resumeDriverId) {
    pendingBookingDriverId = resumeDriverId;
    if (profileModalError) profileModalError.classList.add('is-hidden');
    selectedProfilePhotoFile = null;

    const completeness = checkProfileCompleteness(userProfile, currentUser || {});

    if (profileNameInput) profileNameInput.value = completeness.name || '';
    if (profilePhoneInput) profilePhoneInput.value = (completeness.phone || '').replace(/\D/g, '').slice(0, 10);

    const photo = completeness.photo || (currentUser && currentUser.photoURL) || '';
    if (profileAvatarPreview) {
      profileAvatarPreview.src = photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(completeness.name || 'R')}&background=22c55e&color=fff&size=160`;
    }
    if (profilePhotoHint) {
      profilePhotoHint.textContent = completeness.photoOk ? 'Looks good — tap to change' : 'Tap the camera to add a photo';
    }

    markMissingFields(completeness);
    if (profileModal) profileModal.classList.remove('is-hidden');
  }

  function closeProfileModal() {
    if (profileModal) profileModal.classList.add('is-hidden');
    selectedProfilePhotoFile = null;
  }

  /** Highlight which fields still need attention. */
  function markMissingFields(completeness) {
    if (profileNameField) profileNameField.classList.toggle('is-missing', !completeness.nameOk);
    if (profilePhoneField) profilePhoneField.classList.toggle('is-missing', !completeness.phoneOk);
    if (profileAvatarRing) profileAvatarRing.classList.toggle('is-missing', !completeness.photoOk);
  }

  /** Preview a picked photo locally before upload. */
  function handleProfilePhotoPick(e) {
    const file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please choose an image file.');
      return;
    }
    selectedProfilePhotoFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (profileAvatarPreview) profileAvatarPreview.src = ev.target.result;
      if (profileAvatarRing) profileAvatarRing.classList.remove('is-missing');
      if (profilePhotoHint) profilePhotoHint.textContent = 'Photo ready — tap Save';
    };
    reader.readAsDataURL(file);
  }

  /** Upload the profile photo to users/{uid}/profile/{ts}.jpg (mirrors Android). */
  async function uploadProfilePhoto(file, uid) {
    const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop().toLowerCase() : 'jpg';
    const path = `users/${uid}/profile/${Date.now()}.${ext}`;
    const ref = storage.ref().child(path);
    await ref.put(file, { contentType: file.type || 'image/jpeg' });
    return ref.getDownloadURL();
  }

  /** Validate + persist the profile, then resume the pending booking if valid. */
  async function handleProfileSave() {
    if (!currentUser) return;
    if (profileModalError) profileModalError.classList.add('is-hidden');

    const name = (profileNameInput ? profileNameInput.value : '').trim();
    const phone = (profilePhoneInput ? profilePhoneInput.value : '').replace(/\D/g, '');
    const hasExistingPhoto = Boolean((userProfile && userProfile.photoUrl) || (currentUser && currentUser.photoURL));

    if (!isValidName(name)) {
      return showProfileError('Enter your full name (1–3 words, letters only).');
    }
    if (!isValidPhone(phone)) {
      return showProfileError('Enter a valid 10-digit phone number.');
    }
    if (!selectedProfilePhotoFile && !hasExistingPhoto) {
      return showProfileError('Add a profile photo so drivers can recognise you.');
    }

    try {
      if (profileSaveBtn) {
        profileSaveBtn.disabled = true;
        profileSaveBtn.innerHTML = '<div class="spinner"></div> Saving…';
      }

      let photoUrl = (userProfile && userProfile.photoUrl) || (currentUser && currentUser.photoURL) || '';
      if (selectedProfilePhotoFile) {
        photoUrl = await uploadProfilePhoto(selectedProfilePhotoFile, currentUser.uid);
      }

      // Persist to shared identity doc (camelCase, merge) — matches Android upsertUser.
      await usersCol.doc(currentUser.uid).set({
        displayName: name,
        phone: phone,
        photoUrl: photoUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Refresh local profile + UI.
      userProfile = Object.assign({}, userProfile, { displayName: name, phone: phone, photoUrl: photoUrl });
      userCache.set(currentUser.uid, userProfile);
      renderUserState(currentUser, userProfile);

      showToast('Profile saved!');
      closeProfileModal();

      // Resume whatever the rider was trying to book.
      if (isProfileComplete && pendingBookingDriverId !== undefined) {
        const resume = pendingBookingDriverId;
        pendingBookingDriverId = undefined;
        setTimeout(() => openBookingForm(resume), 150);
      }
    } catch (err) {
      console.error('Failed to save profile:', err);
      showProfileError('Could not save your profile. Please try again.');
    } finally {
      if (profileSaveBtn) {
        profileSaveBtn.disabled = false;
        profileSaveBtn.textContent = 'Save & Continue';
      }
    }
  }

  function showProfileError(msg) {
    if (profileModalError) {
      profileModalError.textContent = msg;
      profileModalError.classList.remove('is-hidden');
    } else {
      showToast(msg);
    }
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
      case 'TUK_TUK': return 'TukTuk';
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

  /**
   * Fetch a driver's real ratings/reviews from Firestore. Mirrors Android
   * FirestoreRatingRepository.observeDriverReviews (targetUid + RIDER_TO_DRIVER).
   * STRICT: no synthetic/sample fallback data — returns [] when there are none.
   */
  async function getDriverReviews(driverUid) {
    if (!driverUid) return [];
    if (driverReviewsCache.has(driverUid)) {
      return driverReviewsCache.get(driverUid);
    }
    try {
      const snap = await ratingsCol
        .where('targetUid', '==', driverUid)
        .where('direction', '==', 'RIDER_TO_DRIVER')
        .limit(20)
        .get();

      const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      driverReviewsCache.set(driverUid, list);
      return list;
    } catch (e) {
      console.warn('Error fetching driver reviews:', e);
      return [];
    }
  }

  /** Normalise a rating doc's reviewer name (Android writes reviewerName; older docs used byName). */
  function reviewerNameOf(r) {
    return (r && (r.reviewerName || r.byName)) || 'Rider';
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

  /**
   * Live listener for online drivers with RTDB presence cross-check.
   *
   * Mirrors Android FirestoreDriverRepository.observeOnlineDrivers: a driver is
   * only shown if Firestore says approved+online AND their Realtime Database
   * heartbeat (driverLocations/{uid}) is online and fresh (≤ 60s). This prevents
   * stale-online drivers from appearing when their app was killed without going
   * offline. STRICT: no synthetic rating/trip/review fallbacks.
   */
  let firestoreDriverDocs = [];
  let rtdbPresence = {}; // uid -> { online, updatedAt, lat, lng }
  let presenceReevalInterval = null;
  let rtdbPresenceRef = null;
  let rtdbPresenceHandler = null;

  /** Pure presence evaluator (mirrors Android isDriverPresenceActive). */
  function isDriverPresenceActive(presence, now) {
    if (!presence || presence.online !== true) return false;
    const ts = presence.updatedAt;
    if (typeof ts !== 'number') return false;
    const diff = now - ts;
    return diff >= -10000 && diff <= HEARTBEAT_FRESHNESS_WINDOW_MS;
  }

  async function reevaluateDrivers() {
    const now = Date.now();
    const activeDocs = firestoreDriverDocs.filter((doc) =>
      isDriverPresenceActive(rtdbPresence[doc.uid], now)
    );

    const drivers = [];
    for (const doc of activeDocs) {
      const data = doc.data;
      const userDoc = await getDriverIdentity(doc.uid);
      const reviews = await getDriverReviews(doc.uid);
      const latestComment = (reviews && reviews.length > 0) ? reviews[0].review : '';
      const loc = rtdbPresence[doc.uid] || {};

      drivers.push({
        uid: doc.uid,
        approvalStatus: data.approvalStatus,
        online: data.online === true,
        busy: data.busy === true,
        ratingAvg: typeof data.ratingAvg === 'number' ? data.ratingAvg : 0,
        ratingCount: typeof data.ratingCount === 'number' ? data.ratingCount : 0,
        tripsCount: typeof data.tripsCount === 'number' ? data.tripsCount : 0,
        latestComment: latestComment,
        vehicle: data.vehicle || {},
        lat: typeof loc.lat === 'number' ? loc.lat : 0,
        lng: typeof loc.lng === 'number' ? loc.lng : 0,
        user: {
          displayName: userDoc.displayName || '',
          photoUrl: userDoc.photoUrl || '',
          phone: userDoc.phone || ''
        }
      });
    }

    allOnlineDrivers = drivers;
    renderDrivers();
  }

  function startDriverListener() {
    stopDriverListener();

    // Firestore: approved + online drivers.
    driverListenersUnsub = driversCol
      .where('approvalStatus', '==', 'APPROVED')
      .where('online', '==', true)
      .onSnapshot((snapshot) => {
        firestoreDriverDocs = snapshot.docs.map((doc) => ({ uid: doc.id, data: doc.data() || {} }));
        reevaluateDrivers();
      }, (error) => {
        console.error('Error observing online drivers:', error);
        showToast('Error loading online drivers.');
      });

    // Realtime Database: driver presence heartbeats.
    rtdbPresenceRef = rtdb.ref(RTDB_LOCATIONS);
    rtdbPresenceHandler = rtdbPresenceRef.on('value', (snap) => {
      rtdbPresence = snap.val() || {};
      reevaluateDrivers();
    }, (err) => {
      console.warn('RTDB presence listener error:', err);
      rtdbPresence = {};
      reevaluateDrivers();
    });

    // Periodic re-evaluation so stale heartbeats expire off the list (Android
    // re-emits every 15s for exactly this reason).
    presenceReevalInterval = setInterval(reevaluateDrivers, 15000);
  }

  function stopDriverListener() {
    if (driverListenersUnsub) {
      driverListenersUnsub();
      driverListenersUnsub = null;
    }
    if (rtdbPresenceRef && rtdbPresenceHandler) {
      rtdbPresenceRef.off('value', rtdbPresenceHandler);
    }
    rtdbPresenceRef = null;
    rtdbPresenceHandler = null;
    if (presenceReevalInterval) {
      clearInterval(presenceReevalInterval);
      presenceReevalInterval = null;
    }
    firestoreDriverDocs = [];
    rtdbPresence = {};
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

  /** Generate HTML for a driver card with visible Ratings and Comments */
  function createDriverCardHtml(driver) {
    const v = driver.vehicle || {};
    const u = driver.user || {};
    const vehicleTypeFormatted = formatVehicleType(v.type);
    const makeModel = `${v.make || 'Vehicle'} ${v.model || ''}`.trim();
    const colour = v.colour ? ` · ${v.colour}` : '';
    const plate = v.plate || '—';
    const seats = v.seats ? `${v.seats} seats` : '—';
    const name = u.displayName || 'Driver';
    const avatar = u.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=22c55e&color=fff&size=128`;
    const hasRating = driver.ratingCount > 0;
    const ratingFormatted = hasRating ? driver.ratingAvg.toFixed(1) : '—';
    const ratingMeta = hasRating
      ? `(${driver.ratingCount} review${driver.ratingCount === 1 ? '' : 's'} · ${driver.tripsCount} trip${driver.tripsCount === 1 ? '' : 's'})`
      : 'New driver';
    const comment = driver.latestComment || '';
    const reviewSnippet = comment
      ? `<div class="driver-review-snippet"><span>💬</span><span>"${escapeHtml(comment)}"</span></div>`
      : '';

    return `
      <article class="driver-card ${driver.busy ? 'is-busy' : ''}" data-driver-id="${driver.uid}">
        <div class="driver-card-top">
          <span class="vehicle-type-tag">${vehicleTypeFormatted}</span>
          <span class="driver-status-badge ${driver.busy ? 'badge-busy' : ''}">
            ${driver.busy ? '🟡 Busy' : '🟢 Available'}
          </span>
        </div>

        <div>
          <div class="vehicle-desc">${escapeHtml(makeModel)}${escapeHtml(colour)}</div>
          <div class="vehicle-meta">
            <span>💺 ${seats}</span>
            <span>·</span>
            <span>🏷️ ${escapeHtml(plate)}</span>
          </div>
        </div>

        ${reviewSnippet}

        <div class="driver-profile-row">
          <img class="driver-avatar" src="${avatar}" alt="${escapeHtml(name)}" onerror="this.src='https://placehold.co/80x80/22c55e/ffffff?text=D'" />
          <div class="driver-info">
            <div class="driver-name">${escapeHtml(name)}</div>
            <div class="driver-rating">
              <span class="star">★</span>
              <strong>${ratingFormatted}</strong>
              <span>${ratingMeta}</span>
            </div>
          </div>
        </div>

        <div class="driver-actions">
          <button class="btn btn-sm btn-ghost" onclick="LaynRiderBooking.openDriverModal('${driver.uid}')">
            Reviews & Profile
          </button>
          <button class="btn btn-sm ${driver.busy ? 'btn-gold' : 'btn-primary'}" onclick="LaynRiderBooking.openBookingForm('${driver.uid}')">
            Book Ride
          </button>
        </div>
      </article>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Open Driver Detail Modal with Ratings and Passenger Reviews */
  async function openDriverModal(driverId) {
    const driver = allOnlineDrivers.find((d) => d.uid === driverId);
    if (!driver) return;

    activeDriverModal = driver;
    const v = driver.vehicle || {};
    const u = driver.user || {};

    if (driverModalAvatar) {
      driverModalAvatar.src = u.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.displayName || 'D')}&background=22c55e&color=fff&size=128`;
    }
    if (driverModalName) driverModalName.textContent = u.displayName || 'Driver';
    if (driverModalVehicleType) driverModalVehicleType.textContent = formatVehicleType(v.type);
    if (driverModalStatus) {
      driverModalStatus.textContent = driver.busy ? '🟡 Currently on a trip (Queue available)' : '🟢 Available now for pickup';
    }
    if (driverModalRating) driverModalRating.textContent = driver.ratingCount > 0 ? `★ ${driver.ratingAvg.toFixed(1)}` : '★ —';
    if (driverModalTrips) driverModalTrips.textContent = `${driver.tripsCount || 0}`;
    if (driverModalSeats) driverModalSeats.textContent = v.seats ? `${v.seats} Seats` : '—';
    if (driverModalVehicleDesc) driverModalVehicleDesc.textContent = `${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    if (driverModalPlate) driverModalPlate.textContent = `Plate: ${v.plate || '—'}`;

    // Load and render real reviews (no synthetic fallback).
    if (driverModalReviewsList) {
      driverModalReviewsList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">Loading passenger reviews…</div>';
      const reviews = await getDriverReviews(driver.uid);
      if (reviews && reviews.length > 0) {
        driverModalReviewsList.innerHTML = reviews.map(r => `
          <div class="review-item-card">
            <div class="review-item-header">
              <span>${escapeHtml(reviewerNameOf(r))}</span>
              <span style="color:var(--brand-gold);">★ ${r.stars || 0}</span>
            </div>
            ${r.review ? `<p class="review-item-comment">"${escapeHtml(r.review)}"</p>` : ''}
          </div>
        `).join('');
      } else {
        driverModalReviewsList.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">No reviews yet. Be the first to rate!</div>';
      }
    }

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
      showToast('Add your details to request a ride.');
      openProfileModal(driverId === undefined ? null : driverId);
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
    if (bookingState.pickup && bookingState.pickup.address) {
      setPickupLocation(bookingState.pickup.address, bookingState.pickup.lat, bookingState.pickup.lng);
    } else {
      if (pickupAddressInput) pickupAddressInput.value = '';
      if (pickupGeofenceBadge) {
        pickupGeofenceBadge.className = 'geofence-badge';
        pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
      }
      if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
    }
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
      showToast('Add your details to request a ride.');
      closeBookingModal();
      openProfileModal(bookingTargetDriver ? bookingTargetDriver.uid : null);
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
        currentDriverId: null,
        offerExpiresAt: null,
        attemptedDriverIds: [],
        dispatchMessage: 'Finding your ride…',
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
      .onSnapshot(async (snap) => {
        if (!snap.empty) {
          const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

          const active = list.find(it => [
            'PENDING', 'QUOTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'
          ].includes(it.status));

          const bookingToDisplay = active || list[0];
          const previousStatus = currentBookingDoc ? currentBookingDoc.status : null;
          currentBookingDoc = bookingToDisplay;

          const isLive = active != null;

          // Sound & Toast feedback when driver sets a price quote
          if (bookingToDisplay.status === 'QUOTED' && previousStatus !== 'QUOTED') {
            playQuoteChime();
            showToast(`Quote received! Driver quoted R ${bookingToDisplay.quotedPrice ? bookingToDisplay.quotedPrice.toFixed(2) : ''}.`);
            openActiveTripModal();
          }

          // Update Dashboard Banner Widget
          renderActiveBookingBanner(bookingToDisplay, isLive);

          // Update Modal Details if open or if active action
          if (activeTripModal && !activeTripModal.classList.contains('is-hidden')) {
            await renderActiveTripDetails(bookingToDisplay);
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

  /** Render Dashboard Active Booking Widget */
  function renderActiveBookingBanner(booking, isLive) {
    if (!activeBookingBanner) return;

    if (!isLive) {
      activeBookingBanner.classList.add('is-hidden');
      return;
    }

    activeBookingBanner.classList.remove('is-hidden');

    if (activeBookingIcon) {
      if (booking.status === 'QUOTED') activeBookingIcon.textContent = '💵';
      else if (booking.status === 'ACCEPTED' || booking.status === 'EN_ROUTE') activeBookingIcon.textContent = '🚗';
      else if (booking.status === 'ARRIVED') activeBookingIcon.textContent = '📍';
      else if (booking.status === 'IN_TRIP') activeBookingIcon.textContent = '🚀';
      else activeBookingIcon.textContent = '🚖';
    }

    if (activeBookingTitle) {
      if (booking.status === 'QUOTED') activeBookingTitle.textContent = `Quote: R ${booking.quotedPrice ? booking.quotedPrice.toFixed(2) : '0.00'}`;
      else if (booking.status === 'EN_ROUTE') activeBookingTitle.textContent = 'Driver En Route';
      else if (booking.status === 'ARRIVED') activeBookingTitle.textContent = 'Driver Arrived!';
      else if (booking.status === 'IN_TRIP') activeBookingTitle.textContent = 'Trip in Progress';
      else activeBookingTitle.textContent = 'Finding your ride…';
    }

    if (activeBookingStatusText) {
      activeBookingStatusText.textContent = booking.dispatchMessage || formatBookingStatus(booking.status);
    }
  }

  function formatBookingStatus(status) {
    switch (status) {
      case 'PENDING': return 'Finding your ride / Driver reviewing…';
      case 'QUOTED': return 'Price quoted! 60s to approve.';
      case 'ACCEPTED': return 'Driver accepted your ride.';
      case 'EN_ROUTE': return 'Driver is en route to pickup.';
      case 'ARRIVED': return 'Driver has arrived at pickup!';
      case 'IN_TRIP': return 'Heading to drop-off destination.';
      case 'COMPLETED': return 'Trip completed!';
      case 'CANCELLED_NO_DRIVER': return 'No drivers available.';
      case 'DRIVER_UNAVAILABLE': return 'Driver unavailable.';
      case 'CANCELLED_EXPIRED': return 'Quote approval expired.';
      case 'CANCELLED': return 'Ride request cancelled.';
      default: return status || 'In progress';
    }
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

      if (cancelPendingBtn) {
        if (booking.deliveredAt != null) {
          cancelPendingBtn.disabled = true;
          cancelPendingBtn.textContent = 'Driver reviewing (cannot cancel)';
        } else {
          cancelPendingBtn.disabled = false;
          cancelPendingBtn.textContent = 'Cancel Request';
        }
      }
    } else if (status === 'QUOTED') {
      // 2. Quote Handshake (Shows who the driver is + 60s countdown)
      if (trackQuotedSection) trackQuotedSection.classList.remove('is-hidden');
      
      await renderQuotedDriverHeader(booking);

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

  /** Render Driver Identity header inside Quote Handshake */
  async function renderQuotedDriverHeader(booking) {
    const driverUid = booking.driverId || booking.requestedDriverId;
    const userDoc = await getDriverIdentity(driverUid);
    const driverDoc = await getDriverRecord(driverUid);

    const v = driverDoc.vehicle || {};
    const name = userDoc.displayName || 'Driver';
    const avatar = userDoc.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=22c55e&color=fff&size=128`;
    const hasRating = typeof driverDoc.ratingCount === 'number' && driverDoc.ratingCount > 0;
    const rating = hasRating ? driverDoc.ratingAvg.toFixed(1) : '—';
    const trips = typeof driverDoc.tripsCount === 'number' ? driverDoc.tripsCount : 0;

    if (quotedDriverAvatar) quotedDriverAvatar.src = avatar;
    if (quotedDriverName) quotedDriverName.textContent = name;
    if (quotedDriverRating) quotedDriverRating.textContent = `★ ${rating} (${trips} trip${trips === 1 ? '' : 's'})`;
    if (quotedDriverVehicle) {
      quotedDriverVehicle.textContent = `${formatVehicleType(booking.vehicleType)} · ${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    }
    if (quotedDriverPlate) quotedDriverPlate.textContent = v.plate || '—';
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

  /**
   * Pending countdown — display only, anchored to the server deadline
   * (booking.offerExpiresAt). The server (Cloud Tasks) owns the actual timeout
   * and roll-to-next-driver, so the client NEVER writes a terminal status here.
   */
  function startPendingCountdown(booking) {
    const deadline = readEpochMillis(booking.offerExpiresAt);

    function update() {
      if (deadline == null) {
        // No live offer yet (still searching). Show the server's message.
        if (pendingCountdown) pendingCountdown.textContent = '…';
        if (activeBookingCountdownPill) activeBookingCountdownPill.classList.add('is-hidden');
        return;
      }
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const formatted = formatTimerSeconds(remaining);
      if (pendingCountdown) pendingCountdown.textContent = formatted;
      if (activeBookingCountdownPill) {
        activeBookingCountdownPill.textContent = `⏱️ ${formatted}`;
        activeBookingCountdownPill.classList.remove('is-hidden');
      }
      if (remaining <= 0) {
        clearInterval(pendingTimerInterval);
        pendingTimerInterval = null;
        // Do not write status — the server transitions the booking.
      }
    }

    update();
    pendingTimerInterval = setInterval(update, 1000);
  }

  /**
   * Quote countdown — display only, anchored to the server deadline
   * (booking.offerExpiresAt, the QUOTE window). The server expires unapproved
   * quotes; the client never writes CANCELLED_EXPIRED itself.
   */
  function startQuoteCountdown(booking) {
    const deadline = readEpochMillis(booking.offerExpiresAt);

    function update() {
      const remaining = deadline == null
        ? 0
        : Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const formatted = formatTimerSeconds(remaining);
      if (quotedCountdown) quotedCountdown.textContent = formatted;
      if (activeBookingCountdownPill) {
        activeBookingCountdownPill.textContent = `⏱️ ${formatted}`;
        activeBookingCountdownPill.classList.remove('is-hidden');
      }
      if (remaining <= 0) {
        clearInterval(quoteTimerInterval);
        quoteTimerInterval = null;
        // Do not write status — the server expires the quote.
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
    const name = userDoc.displayName || 'Driver';
    const phone = userDoc.phone || '';
    const avatar = userDoc.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=22c55e&color=fff&size=128`;

    if (trackDriverAvatar) trackDriverAvatar.src = avatar;
    if (trackDriverName) trackDriverName.textContent = name;
    if (trackVehicleDesc) {
      trackVehicleDesc.textContent = `${formatVehicleType(booking.vehicleType)} · ${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    }
    if (trackVehiclePlate) trackVehiclePlate.textContent = v.plate || '—';

    if (trackCallBtn) {
      trackCallBtn.href = phone ? `tel:${phone}` : '#';
      trackCallBtn.classList.toggle('is-hidden', !phone);
    }
    if (trackWhatsappBtn) {
      const cleanPhone = phone.startsWith('0') ? '27' + phone.substring(1) : phone;
      trackWhatsappBtn.href = phone ? `https://wa.me/${cleanPhone}?text=Hello%20${encodeURIComponent(name)}%2C%20this%20is%20your%20LaynRider%20passenger.` : '#';
      trackWhatsappBtn.classList.toggle('is-hidden', !phone);
    }

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

    if (activeBookingCountdownPill) {
      activeBookingCountdownPill.classList.add('is-hidden');
    }
  }

  /** Cancel Pending Request → server (cancelBookingCallable). */
  async function handleCancelPending() {
    if (!currentBookingDoc) return;
    try {
      if (cancelPendingBtn) cancelPendingBtn.disabled = true;
      await callFn('cancelBookingCallable', {
        bookingId: currentBookingDoc.id,
        reason: 'Cancelled by rider before dispatch confirmation.',
        byDriver: false
      });
      showToast('Ride request cancelled.');
    } catch (err) {
      console.error('Failed to cancel ride:', err);
      showToast('Could not cancel ride.');
    } finally {
      if (cancelPendingBtn) cancelPendingBtn.disabled = false;
    }
  }

  /** Approve Quote → server (approveQuoteCallable; QUOTED → EN_ROUTE). */
  async function handleApproveQuote() {
    if (!currentBookingDoc) return;
    try {
      if (approveQuoteBtn) approveQuoteBtn.disabled = true;
      await callFn('approveQuoteCallable', { bookingId: currentBookingDoc.id });
      showToast('Quote approved! Driver confirmed.');
    } catch (err) {
      console.error('Failed to approve quote:', err);
      showToast('Could not approve quote. Please try again.');
    } finally {
      if (approveQuoteBtn) approveQuoteBtn.disabled = false;
    }
  }

  /** Decline Quote → server (rejectQuoteCallable; Quick Ride rolls on, specific driver ends). */
  async function handleDeclineQuote() {
    if (!currentBookingDoc) return;
    try {
      if (declineQuoteBtn) declineQuoteBtn.disabled = true;
      await callFn('rejectQuoteCallable', {
        bookingId: currentBookingDoc.id,
        reason: 'Rider declined driver price quote.'
      });
      showToast('Quote declined.');
    } catch (err) {
      console.error('Failed to decline quote:', err);
      showToast('Could not decline quote.');
    } finally {
      if (declineQuoteBtn) declineQuoteBtn.disabled = false;
    }
  }

  /** Submit Rating and Done (mirrors Android FirestoreRatingRepository). */
  async function handleCompletedDone() {
    if (completedDoneBtn) completedDoneBtn.disabled = true;

    if (currentBookingDoc && currentBookingDoc.status === 'COMPLETED') {
      const driverUid = currentBookingDoc.driverId || currentBookingDoc.requestedDriverId;
      const comment = tripReviewComment ? tripReviewComment.value.trim() : '';

      if (driverUid) {
        try {
          // Dedupe: one rating per trip per rider (Android hasRated).
          const existing = await ratingsCol
            .where('tripId', '==', currentBookingDoc.id)
            .where('byUid', '==', currentUser.uid)
            .limit(1)
            .get();

          if (existing.empty) {
            const now = Date.now();
            const ratingId = `r_${now}_${currentUser.uid.substring(0, 6)}`;
            const reviewerName = (userProfile && userProfile.displayName) || currentUser.displayName || 'Rider';

            await ratingsCol.doc(ratingId).set({
              id: ratingId,
              tripId: currentBookingDoc.id,
              byUid: currentUser.uid,
              targetUid: driverUid,
              direction: 'RIDER_TO_DRIVER',
              stars: selectedStars,
              review: comment,
              reviewerName: reviewerName,
              likes: 0,
              createdAt: now
            }, { merge: true });

            await updateDriverRatingAggregates(driverUid);
            driverReviewsCache.delete(driverUid);
          }
        } catch (e) {
          console.warn('Error saving rating:', e);
        }
      }
    }

    showToast('Thank you for your rating!');
    setTimeout(() => {
      if (completedDoneBtn) completedDoneBtn.disabled = false;
      closeActiveTripModal();
    }, 1000);
  }

  /**
   * Recompute a driver's ratingAvg/ratingCount from all RIDER_TO_DRIVER ratings
   * (mirrors Android updateRatingAggregates). STRICT: derived only from real
   * rating docs — no defaults.
   */
  async function updateDriverRatingAggregates(driverUid) {
    const snap = await ratingsCol
      .where('targetUid', '==', driverUid)
      .where('direction', '==', 'RIDER_TO_DRIVER')
      .get();

    const stars = snap.docs
      .map(d => d.data().stars)
      .filter(s => typeof s === 'number');
    if (stars.length === 0) return;

    const avg = stars.reduce((a, b) => a + b, 0) / stars.length;
    await driversCol.doc(driverUid).set(
      { ratingAvg: avg, ratingCount: stars.length },
      { merge: true }
    );
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
      // LaynFleet reuses the global authentication system
      sessionStorage.setItem('redirectUrl', window.location.href);
      window.top.location.replace('../../authentication/login.html?redirect=' + encodeURIComponent(window.location.href));
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
    const firstName = (displayName.split(' ')[0]) || 'Rider';
    if (headerUserName) headerUserName.textContent = firstName;
    if (heroNameEl) heroNameEl.textContent = firstName;
    if (headerAvatar) {
      if (completeness.photo) {
        headerAvatar.src = completeness.photo;
        headerAvatar.classList.remove('is-hidden');
      } else {
        headerAvatar.src = 'https://placehold.co/100x100/22c55e/ffffff?text=' + encodeURIComponent(displayName[0] || 'R');
      }
    }

    updateProfileChecklist(completeness);
    if (profileIncompleteBanner) {
      profileIncompleteBanner.classList.toggle('is-hidden', isProfileComplete);
    }

    showView('app');
    startDriverListener();
    startActiveBookingListener(authUser.uid);
  }

  /** Sign Out */
  async function handleSignOut() {
    try {
      stopDriverListener();
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      if (typeof AuthStore !== 'undefined' && AuthStore.signOut) {
        await AuthStore.signOut();
      } else {
        await auth.signOut();
      }
      showToast('Signed out');
      window.top.location.replace('../../authentication/login.html');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }

  /** Event Listeners */
  function initListeners() {
    if (headerSignOutBtn) headerSignOutBtn.addEventListener('click', handleSignOut);
    const suspendedSignOutBtn = document.getElementById('suspended-signout-btn');
    if (suspendedSignOutBtn) suspendedSignOutBtn.addEventListener('click', handleSignOut);

    if (completeProfileBtn) completeProfileBtn.addEventListener('click', () => openProfileModal(undefined));
    if (headerUserBtn) headerUserBtn.addEventListener('click', () => openProfileModal(undefined));

    // Profile Completion Modal
    if (profileModalClose) profileModalClose.addEventListener('click', closeProfileModal);
    if (profilePhotoInput) profilePhotoInput.addEventListener('change', handleProfilePhotoPick);
    if (profileSaveBtn) profileSaveBtn.addEventListener('click', handleProfileSave);
    if (profilePhoneInput) {
      profilePhoneInput.addEventListener('input', () => {
        profilePhoneInput.value = profilePhoneInput.value.replace(/\D/g, '').slice(0, 10);
        if (profilePhoneField) profilePhoneField.classList.toggle('is-missing', !isValidPhone(profilePhoneInput.value));
      });
    }
    if (profileNameInput) {
      profileNameInput.addEventListener('input', () => {
        if (profileNameField) profileNameField.classList.toggle('is-missing', !isValidName(profileNameInput.value.trim()));
      });
    }
    if (profileModal) {
      profileModal.addEventListener('click', (e) => {
        if (e.target === profileModal) closeProfileModal();
      });
    }

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
