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
      lat: null,
      lng: null
    },
    dropoff: {
      address: '',
      lat: null,
      lng: null
    },
    note: '',
    vehicleType: 'PRIVATE_CAR',
    isReturnTrip: true,
    scheduledEpoch: null,
    actualOneWayDistanceKm: null, // Populated ONLY when actual driving road distance is measured by Google Directions
    upfrontPrice: null,
    estimatedDistanceKm: null,
    ratePerKmSnapshot: null,
    minimumFareSnapshot: null,
    returnPercentSnapshot: null
  };

  const DEFAULT_PRICING_RATES = {
    PRIVATE_CAR: { ratePerKm: 10.0, minimumFare: 25.0, returnTripPercent: 80.0 },
    MINI_BUS: { ratePerKm: 12.0, minimumFare: 30.0, returnTripPercent: 80.0 },
    BAKKIE: { ratePerKm: 12.0, minimumFare: 30.0, returnTripPercent: 80.0 },
    MOTORBIKE: { ratePerKm: 7.0, minimumFare: 18.0, returnTripPercent: 80.0 },
    TUK_TUK: { ratePerKm: 6.0, minimumFare: 15.0, returnTripPercent: 80.0 }
  };
  let activePricingRates = { ...DEFAULT_PRICING_RATES };

  // User cache for driver identities & reviews
  const userCache = new Map();
  const driverReviewsCache = new Map();
  const driverTripsCache = new Map();

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
  const headerDriverCountEl = document.getElementById('header-driver-count');
  const heroDriverCountBadge = document.getElementById('hero-driver-count-badge');
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
  const toggleTripReturn = document.getElementById('toggle-trip-return');
  const toggleTripSingle = document.getElementById('toggle-trip-single');
  const toggleTypeAsap = document.getElementById('toggle-type-asap');
  const toggleTypeScheduled = document.getElementById('toggle-type-scheduled');
  const scheduledFields = document.getElementById('scheduled-fields');
  const scheduledDateInput = document.getElementById('booking-scheduled-date');
  const scheduledTimeInput = document.getElementById('booking-scheduled-time');
  const pickupAddressInput = document.getElementById('booking-pickup-address');
  const pickupClearBtn = document.getElementById('pickup-clear-btn');
  const pickupGpsBtn = document.getElementById('pickup-gps-btn');
  const pickupGeofenceBadge = document.getElementById('pickup-geofence-badge');
  const pickupErrorEl = document.getElementById('pickup-error');
  const dropoffAddressInput = document.getElementById('booking-dropoff-address');
  const dropoffClearBtn = document.getElementById('dropoff-clear-btn');
  const bookingNoteInput = document.getElementById('booking-note');
  const bookingNoteCount = document.getElementById('booking-note-count');
  const bookingFormError = document.getElementById('booking-form-error');

  // Active Trip / Tracking Modal Elements
  const activeTripModal = document.getElementById('active-trip-modal');
  const activeTripModalClose = document.getElementById('active-trip-modal-close');
  const trackBookingId = document.getElementById('track-booking-id');

  // Stepper Elements (Direct Accept Model: Request -> Accepted -> En Route -> In Trip -> Done)
  const stepRequested = document.getElementById('step-requested');
  const stepAccepted = document.getElementById('step-accepted');
  const stepEnroute = document.getElementById('step-enroute');
  const stepTrip = document.getElementById('step-trip');
  const stepCompleted = document.getElementById('step-completed');

  // Trip State Sections
  const trackPendingSection = document.getElementById('track-pending-section');
  const pendingSectionTitle = document.getElementById('pending-section-title');
  const pendingSectionDesc = document.getElementById('pending-section-desc');
  const pendingCountdownLabel = document.getElementById('pending-countdown-label');
  const pendingCountdown = document.getElementById('pending-countdown');
  const cancelPendingBtn = document.getElementById('cancel-pending-btn');

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
  const completedDistanceAmount = document.getElementById('completed-distance-amount');
  const completedDoneBtn = document.getElementById('completed-done-btn');
  const tripReviewComment = document.getElementById('trip-review-comment');
  const ratingStarBtns = document.querySelectorAll('.rating-star-btn');

  const trackCancelledSection = document.getElementById('track-cancelled-section');
  const cancelledIcon = document.getElementById('cancelled-icon');
  const cancelledTitle = document.getElementById('cancelled-title');
  const cancelledReasonText = document.getElementById('cancelled-reason-text');
  const cancelledDismissBtn = document.getElementById('cancelled-dismiss-btn');

  // Map Elements
  const bookingMapCard = document.getElementById('booking-map-card');
  const bookingMapEl = document.getElementById('booking-map');
  const bookingMapRouteInfo = document.getElementById('booking-map-route-info');
  const bookingMapDistance = document.getElementById('booking-map-distance');
  const bookingMapDuration = document.getElementById('booking-map-duration');

  const trackingMapCard = document.getElementById('tracking-map-card');
  const trackingMapEl = document.getElementById('tracking-map');
  const trackingMapRouteInfo = document.getElementById('tracking-map-route-info');
  const trackingMapDistance = document.getElementById('tracking-map-distance');
  const trackingMapDuration = document.getElementById('tracking-map-duration');

  // Google Maps State
  let bookingGoogleMap = null;
  let bookingDirectionsService = null;
  let bookingDirectionsRenderer = null;
  let bookingPickupMarker = null;
  let bookingDropoffMarker = null;
  let bookingPoortjieCircle = null;

  let trackingGoogleMap = null;
  let trackingDirectionsService = null;
  let trackingDirectionsRenderer = null;
  let trackingPickupMarker = null;
  let trackingDropoffMarker = null;
  let trackingDriverMarker = null;

  // Toast
  const toastEl = document.getElementById('toast');

  // Confirm Booking Modal Elements
  const confirmBookingModal = document.getElementById('confirm-booking-modal');
  const confirmBookingModalClose = document.getElementById('confirm-booking-modal-close');
  const confirmBookingBackBtn = document.getElementById('confirm-booking-back-btn');
  const confirmBookingSubmitBtn = document.getElementById('confirm-booking-submit-btn');
  const confirmPickupText = document.getElementById('confirm-pickup-text');
  const confirmDropoffText = document.getElementById('confirm-dropoff-text');
  const confirmTripType = document.getElementById('confirm-trip-type');
  const confirmDistanceText = document.getElementById('confirm-distance-text');
  const confirmNoteContainer = document.getElementById('confirm-note-container');
  const confirmNoteText = document.getElementById('confirm-note-text');
  const confirmModalError = document.getElementById('confirm-modal-error');

  // App Test / Beta Modal Elements
  const appTestModal = document.getElementById('app-test-modal');
  const appTestModalClose = document.getElementById('app-test-modal-close');
  const appTestModalCancel = document.getElementById('app-test-modal-cancel');
  const appTestDownloadBtn = document.getElementById('app-test-download-btn');

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

  /** Calculate and update upfront fare preview card and submit button ONLY with actual driving road distance */
  function updateUpfrontFarePreview(overrideDistanceKm = null) {
    const vType = (bookingState.vehicleType || 'PRIVATE_CAR').toUpperCase();
    const rateInfo = activePricingRates[vType] || DEFAULT_PRICING_RATES[vType] || { ratePerKm: 10.0, minimumFare: 25.0, returnTripPercent: 80.0 };

    const fareAmountEl = document.getElementById('booking-fare-amount') || document.getElementById('booking-distance-amount');
    const fareBreakdownEl = document.getElementById('booking-fare-breakdown') || document.getElementById('booking-distance-breakdown');
    const submitBtn = document.getElementById('booking-submit-btn');

    const hasPickupAddress = Boolean(bookingState.pickup && bookingState.pickup.address && bookingState.pickup.address.trim());
    const hasPickupCoords = Boolean(bookingState.pickup && typeof bookingState.pickup.lat === 'number' && typeof bookingState.pickup.lng === 'number' && !isNaN(bookingState.pickup.lat) && bookingState.pickup.lat !== 0);
    const hasDropoffAddress = Boolean(bookingState.dropoff && bookingState.dropoff.address && bookingState.dropoff.address.trim());
    const hasDropoffCoords = Boolean(bookingState.dropoff && typeof bookingState.dropoff.lat === 'number' && typeof bookingState.dropoff.lng === 'number' && !isNaN(bookingState.dropoff.lat) && bookingState.dropoff.lat !== 0);

    const hasPickup = hasPickupAddress && hasPickupCoords;
    const hasDropoff = hasDropoffAddress && hasDropoffCoords;

    if (overrideDistanceKm != null && typeof overrideDistanceKm === 'number' && !isNaN(overrideDistanceKm) && overrideDistanceKm > 0) {
      bookingState.actualOneWayDistanceKm = overrideDistanceKm;
    }

    if (!hasPickup || !hasDropoff) {
      bookingState.actualOneWayDistanceKm = null;
      bookingState.estimatedDistanceKm = null;
      bookingState.upfrontPrice = null;
      bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
      bookingState.minimumFareSnapshot = rateInfo.minimumFare;
      bookingState.returnPercentSnapshot = bookingState.isReturnTrip !== false ? rateInfo.returnTripPercent : null;

      if (fareAmountEl) fareAmountEl.textContent = 'R --';
      if (fareBreakdownEl) {
        if (!hasPickup && !hasDropoff) {
          fareBreakdownEl.textContent = 'Enter pickup & destination to calculate fare';
        } else if (!hasPickup) {
          fareBreakdownEl.textContent = 'Enter pickup location';
        } else {
          fareBreakdownEl.textContent = 'Enter destination address';
        }
      }
      if (submitBtn) {
        submitBtn.innerHTML = '<span>⚡</span> Request Ride';
      }
      return;
    }

    // Both pickup & drop-off locations are set. Check if actual road distance has been computed.
    const oneWayDistKm = bookingState.actualOneWayDistanceKm;

    if (oneWayDistKm == null || isNaN(oneWayDistKm) || oneWayDistKm <= 0) {
      // Actual road distance is still being computed by Google Directions
      bookingState.estimatedDistanceKm = null;
      bookingState.upfrontPrice = null;
      bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
      bookingState.minimumFareSnapshot = rateInfo.minimumFare;
      bookingState.returnPercentSnapshot = bookingState.isReturnTrip !== false ? rateInfo.returnTripPercent : null;

      if (fareAmountEl) fareAmountEl.textContent = 'R ...';
      if (fareBreakdownEl) {
        fareBreakdownEl.textContent = 'Calculating route distance & fare…';
      }
      if (submitBtn) {
        submitBtn.innerHTML = '<span>⚡</span> Calculating Route…';
      }
      return;
    }

    // We have the actual measured driving distance from Google Maps!
    const isReturn = bookingState.isReturnTrip !== false;
    const displayDistKm = isReturn ? (oneWayDistKm * 2.0) : oneWayDistKm;
    const returnPercent = typeof rateInfo.returnTripPercent === 'number' ? rateInfo.returnTripPercent : 80.0;
    const singlePrice = Math.max(oneWayDistKm * rateInfo.ratePerKm, rateInfo.minimumFare);
    const rawFare = isReturn ? (singlePrice * (1.0 + returnPercent / 100.0)) : singlePrice;
    const fare = Math.round(rawFare);

    bookingState.estimatedDistanceKm = Number(displayDistKm.toFixed(1));
    bookingState.upfrontPrice = fare;
    bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
    bookingState.minimumFareSnapshot = rateInfo.minimumFare;
    bookingState.returnPercentSnapshot = isReturn ? returnPercent : null;

    if (fareAmountEl) fareAmountEl.textContent = `R ${fare}`;
    if (fareBreakdownEl) {
      fareBreakdownEl.textContent = isReturn
        ? `~${bookingState.estimatedDistanceKm} km total (${oneWayDistKm.toFixed(1)} km return)`
        : `~${bookingState.estimatedDistanceKm} km (Single trip)`;
    }
    if (submitBtn) {
      submitBtn.innerHTML = `<span>⚡</span> Request Ride · R ${fare}`;
    }
  }

  // Alias for backward compatibility
  const updateBookingDistancePreview = updateUpfrontFarePreview;

  /** Listen for dynamic democratic pricing rates from Firestore */
  function initPricingRatesListener() {
    try {
      const pricingCol = db.collection('laynfleet').doc('main').collection('pricing');
      pricingCol.onSnapshot((snapshot) => {
        snapshot.forEach((doc) => {
          const data = doc.data() || {};
          const vType = (data.vehicleType || doc.id).toUpperCase();
          activePricingRates[vType] = {
            ratePerKm: typeof data.ratePerKm === 'number' ? data.ratePerKm : (DEFAULT_PRICING_RATES[vType]?.ratePerKm || 10.0),
            minimumFare: typeof data.minimumFare === 'number' ? data.minimumFare : (DEFAULT_PRICING_RATES[vType]?.minimumFare || 25.0),
            returnTripPercent: typeof data.returnTripPercent === 'number' ? data.returnTripPercent : (DEFAULT_PRICING_RATES[vType]?.returnTripPercent || 80.0)
          };
        });
        updateUpfrontFarePreview();
      }, (err) => {
        console.warn('[LaynRider] Pricing rates listener warning:', err);
      });
    } catch (err) {
      console.warn('[LaynRider] Failed to init pricing rates listener:', err);
    }
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

      // Check if there is a pending ride booking to resume
      let pendingRaw = null;
      try {
        pendingRaw = sessionStorage.getItem('pendingRideBooking');
      } catch (e) {}

      if (pendingRaw) {
        let pendingRide = null;
        try { pendingRide = JSON.parse(pendingRaw); } catch(e) {}
        if (pendingRide && isProfileComplete) {
          sessionStorage.removeItem('pendingRideBooking');
          setTimeout(() => {
            openConfirmBookingModal();
          }, 200);
          return;
        }
      }

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
   * Fetch a driver's real completed trips count from Firestore bookings collection.
   * Cross-checks with driver document and keeps tripsCount aggregate updated.
   * STRICT: Real count from bookings (status == 'COMPLETED').
   */
  async function getDriverTripsCount(driverUid) {
    if (!driverUid) return 0;
    if (driverTripsCache.has(driverUid)) {
      return driverTripsCache.get(driverUid);
    }
    try {
      const snap = await bookingsCol
        .where('driverId', '==', driverUid)
        .get();

      const completedCount = snap.docs.filter((d) => {
        const b = d.data() || {};
        return b.status === 'COMPLETED';
      }).length;

      const driverDoc = await getDriverRecord(driverUid);
      const docCount = typeof driverDoc.tripsCount === 'number' ? driverDoc.tripsCount : 0;
      const realTrips = Math.max(completedCount, docCount);

      if (completedCount > docCount && currentUser) {
        driversCol.doc(driverUid).set(
          { tripsCount: realTrips },
          { merge: true }
        ).catch((err) => console.warn('Could not sync driver tripsCount:', err));
      }

      driverTripsCache.set(driverUid, realTrips);
      return realTrips;
    } catch (e) {
      console.warn('Failed to count trips for driver:', driverUid, e);
      const driverDoc = await getDriverRecord(driverUid);
      const docCount = typeof driverDoc.tripsCount === 'number' ? driverDoc.tripsCount : 0;
      driverTripsCache.set(driverUid, docCount);
      return docCount;
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

      let likedSet = new Set();
      if (currentUser) {
        try {
          const likesSnap = await reviewLikesCol
            .where('byUid', '==', currentUser.uid)
            .get();
          likedSet = new Set(likesSnap.docs.map(d => d.data().ratingId));
        } catch (err) {
          console.warn('Error fetching review likes:', err);
        }
      }

      const list = snap.docs
        .map(d => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            likes: Math.max(0, data.likes || 0),
            likedByCurrentUser: likedSet.has(d.id),
          };
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      driverReviewsCache.set(driverUid, list);
      return list;
    } catch (e) {
      console.warn('Error fetching driver reviews:', e);
      return [];
    }
  }

  /**
   * Toggle social like on a driver review (mirrors Android FirestoreRatingRepository.likeReview).
   * Atomically flips like doc and increments/decrements rating likes counter.
   */
  async function toggleLikeReview(ratingId, driverUid) {
    if (!currentUser) {
      showToast('Sign in to like reviews.');
      return;
    }
    const likeDocRef = reviewLikesCol.doc(`${ratingId}_${currentUser.uid}`);
    const ratingDocRef = ratingsCol.doc(ratingId);
    try {
      await db.runTransaction(async (transaction) => {
        const likeDoc = await transaction.get(likeDocRef);
        if (likeDoc.exists) {
          transaction.delete(likeDocRef);
          transaction.update(ratingDocRef, {
            likes: firebase.firestore.FieldValue.increment(-1)
          });
        } else {
          transaction.set(likeDocRef, {
            ratingId: ratingId,
            byUid: currentUser.uid,
            createdAt: Date.now()
          });
          transaction.update(ratingDocRef, {
            likes: firebase.firestore.FieldValue.increment(1)
          });
        }
      });
      driverReviewsCache.delete(driverUid);
      if (activeDriverModal && activeDriverModal.uid === driverUid) {
        openDriverModal(activeDriverModal);
      }
    } catch (err) {
      console.warn('Error toggling like:', err);
      showToast('Could not update like.');
    }
  }

  /** Mask reviewer/user names with asterisks (e.g. "John Doe" -> "J*** D***") for privacy. */
  function maskUserName(name) {
    if (!name || !name.trim()) return '***';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '***';
    return parts.map(part => `${part.charAt(0)}***`).join(' ');
  }

  /** Normalise a rating doc's reviewer name (Android writes reviewerName; older docs used byName). */
  function reviewerNameOf(r) {
    return (r && (r.reviewerName || r.byName)) || 'Rider';
  }

  /** ============================================================
   * GOOGLE MAPS & DIRECTIONS INTEGRATION
   * ============================================================ */
  function initBookingMap() {
    if (bookingGoogleMap || !bookingMapEl || !global.google || !global.google.maps) return;

    try {
      console.log('[LaynRider Map] 🗺️ Initializing Booking Google Map...');
      const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
      bookingGoogleMap = new google.maps.Map(bookingMapEl, {
        center: poortjieCenter,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false
      });

      bookingPoortjieCircle = new google.maps.Circle({
        center: poortjieCenter,
        radius: SERVICE_AREA.radiusMeters,
        strokeColor: '#0288D1',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: '#0288D1',
        fillOpacity: 0.12,
        map: bookingGoogleMap
      });

      bookingDirectionsService = new google.maps.DirectionsService();
      bookingDirectionsRenderer = new google.maps.DirectionsRenderer({
        map: bookingGoogleMap,
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: '#0288D1',
          strokeWeight: 5,
          strokeOpacity: 0.9
        }
      });
      console.log('[LaynRider Map] ✅ Booking Google Map initialized successfully.');
    } catch (err) {
      console.error('[LaynRider Map] ❌ Error initializing booking map:', err);
    }
  }

  function updateBookingMap() {
    if (!bookingGoogleMap) {
      initBookingMap();
    }
    if (!bookingGoogleMap) return;

    const hasPickupAddress = Boolean(bookingState.pickup && bookingState.pickup.address && bookingState.pickup.address.trim());
    const hasPickupCoords = Boolean(bookingState.pickup && typeof bookingState.pickup.lat === 'number' && typeof bookingState.pickup.lng === 'number' && !isNaN(bookingState.pickup.lat) && bookingState.pickup.lat !== 0);
    const hasDropoffAddress = Boolean(bookingState.dropoff && bookingState.dropoff.address && bookingState.dropoff.address.trim());
    const hasDropoffCoords = Boolean(bookingState.dropoff && typeof bookingState.dropoff.lat === 'number' && typeof bookingState.dropoff.lng === 'number' && !isNaN(bookingState.dropoff.lat) && bookingState.dropoff.lat !== 0);

    const hasPickup = hasPickupAddress && hasPickupCoords;
    const hasDropoff = hasDropoffAddress && hasDropoffCoords;

    console.log('[LaynRider Map] 🗺️ [BOOKING MAP UPDATE] hasPickup=' + hasPickup + ', hasDropoff=' + hasDropoff);

    // Update Pickup Marker
    if (hasPickup) {
      const pos = new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng);
      if (!bookingPickupMarker) {
        bookingPickupMarker = new google.maps.Marker({
          position: pos,
          map: bookingGoogleMap,
          title: 'Pickup: ' + (bookingState.pickup.address || 'Pickup'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        bookingPickupMarker.setPosition(pos);
        bookingPickupMarker.setMap(bookingGoogleMap);
      }
    } else if (bookingPickupMarker) {
      bookingPickupMarker.setMap(null);
      bookingPickupMarker = null;
    }

    // Update Dropoff Marker
    if (hasDropoff) {
      const pos = new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng);
      if (!bookingDropoffMarker) {
        bookingDropoffMarker = new google.maps.Marker({
          position: pos,
          map: bookingGoogleMap,
          title: 'Drop-off: ' + (bookingState.dropoff.address || 'Destination'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        bookingDropoffMarker.setPosition(pos);
        bookingDropoffMarker.setMap(bookingGoogleMap);
      }
    } else if (bookingDropoffMarker) {
      bookingDropoffMarker.setMap(null);
      bookingDropoffMarker = null;
    }

    // Calculate Driving Route Directions if both endpoints are set with valid addresses & coordinates
    if (hasPickup && hasDropoff) {
      const origin = new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng);
      const destination = new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng);

      console.log('[LaynRider Map] 🗺️ [DIRECTIONS START] Origin: (' + bookingState.pickup.lat + ', ' + bookingState.pickup.lng + ') -> Dest: (' + bookingState.dropoff.lat + ', ' + bookingState.dropoff.lng + ')');

      // Clear existing distance/price while calculating so the UI displays calculating state
      bookingState.actualOneWayDistanceKm = null;
      updateUpfrontFarePreview(null);

      const request = {
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING
      };

      bookingDirectionsService.route(request, (result, status) => {
        const response = result || {};
        console.log("=== GOOGLE MAPS ROUTE QA LOG ===");
        console.log("API Status Code:", response.status || status);
        if (response.routes && response.routes[0]) {
            const leg = response.routes[0].legs[0];
            console.log("Verification Status: SUCCESS (Using actual road grid)");
            console.log("Total Turn-by-Turn Steps:", leg.steps.length);
            console.log("API Calculated Real Distance:", leg.distance.text, `(${leg.distance.value} meters)`);
        } else {
            console.log("Verification Status: FAILED (Check for coordinate inversion or off-road pins)");
        }
        console.log("================================");

        if (status === google.maps.DirectionsStatus.OK) {
          bookingDirectionsRenderer.setDirections(result);
          const route = result.routes[0];
          const leg = route.legs[0];
          console.log('[LaynRider Map] ✅ [DIRECTIONS SUCCESS] Route: ' + leg.distance.text + ', duration: ' + leg.duration.text + ', path points: ' + route.overview_path.length);

          if (bookingMapRouteInfo) {
            if (bookingMapDistance) bookingMapDistance.textContent = leg.distance.text;
            if (bookingMapDuration) bookingMapDuration.textContent = leg.duration.text;
            bookingMapRouteInfo.classList.remove('is-hidden');
          }

          if (leg.distance && typeof leg.distance.value === 'number') {
            const distKm = leg.distance.value / 1000.0;
            bookingState.actualOneWayDistanceKm = distKm;
            updateUpfrontFarePreview(distKm);
          }

          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          bookingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        } else {
          console.warn('[LaynRider Map] ⚠️ [DIRECTIONS WARN] Directions request failed with status: ' + status);
          bookingState.actualOneWayDistanceKm = null;
          if (bookingMapRouteInfo) bookingMapRouteInfo.classList.add('is-hidden');
          updateBookingDistancePreview(null);
          const distanceBreakdownEl = document.getElementById('booking-distance-breakdown') || document.getElementById('booking-fare-breakdown');
          if (distanceBreakdownEl) distanceBreakdownEl.textContent = 'Could not determine driving route. Check addresses.';
          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          bookingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        }
      });
    } else {
      bookingState.actualOneWayDistanceKm = null;
      if (bookingDirectionsRenderer) {
        bookingDirectionsRenderer.set('directions', null);
      }
      if (bookingMapRouteInfo) bookingMapRouteInfo.classList.add('is-hidden');
      updateBookingDistancePreview(null);

      if (hasPickup) {
        bookingGoogleMap.setCenter(new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng));
        bookingGoogleMap.setZoom(15);
      } else if (hasDropoff) {
        bookingGoogleMap.setCenter(new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng));
        bookingGoogleMap.setZoom(14);
      } else {
        bookingGoogleMap.setCenter(new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng));
        bookingGoogleMap.setZoom(14);
      }
    }
  }

  function initTrackingMap() {
    if (trackingGoogleMap || !trackingMapEl || !global.google || !global.google.maps) return;

    try {
      console.log('[LaynRider Map] 🗺️ Initializing Tracking Google Map...');
      const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
      trackingGoogleMap = new google.maps.Map(trackingMapEl, {
        center: poortjieCenter,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false
      });

      trackingDirectionsService = new google.maps.DirectionsService();
      trackingDirectionsRenderer = new google.maps.DirectionsRenderer({
        map: trackingGoogleMap,
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: '#0288D1',
          strokeWeight: 5,
          strokeOpacity: 0.9
        }
      });
      console.log('[LaynRider Map] ✅ Tracking Google Map initialized successfully.');
    } catch (err) {
      console.error('[LaynRider Map] ❌ Error initializing tracking map:', err);
    }
  }

  function updateTrackingMap(b) {
    if (!b) return;
    if (!trackingGoogleMap) {
      initTrackingMap();
    }
    if (!trackingGoogleMap) return;

    const p = b.pickup || {};
    const d = b.dropoff || {};
    const hasP = typeof p.lat === 'number' && typeof p.lng === 'number' && p.lat !== 0;
    const hasD = typeof d.lat === 'number' && typeof d.lng === 'number' && d.lat !== 0;

    if (hasP) {
      const pPos = new google.maps.LatLng(p.lat, p.lng);
      if (!trackingPickupMarker) {
        trackingPickupMarker = new google.maps.Marker({
          position: pPos,
          map: trackingGoogleMap,
          title: 'Pickup: ' + (p.address || 'Pickup'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingPickupMarker.setPosition(pPos);
        trackingPickupMarker.setMap(trackingGoogleMap);
      }
    }

    if (hasD) {
      const dPos = new google.maps.LatLng(d.lat, d.lng);
      if (!trackingDropoffMarker) {
        trackingDropoffMarker = new google.maps.Marker({
          position: dPos,
          map: trackingGoogleMap,
          title: 'Drop-off: ' + (d.address || 'Destination'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingDropoffMarker.setPosition(dPos);
        trackingDropoffMarker.setMap(trackingGoogleMap);
      }
    }

    // Check for Driver Location
    const driverUid = b.driverId || b.requestedDriverId;
    const driverPresence = driverUid ? rtdbPresence[driverUid] : null;
    const hasDriverLoc = driverPresence && typeof driverPresence.lat === 'number' && typeof driverPresence.lng === 'number' && driverPresence.lat !== 0;

    if (hasDriverLoc) {
      const driverPos = new google.maps.LatLng(driverPresence.lat, driverPresence.lng);
      if (!trackingDriverMarker) {
        trackingDriverMarker = new google.maps.Marker({
          position: driverPos,
          map: trackingGoogleMap,
          title: 'Driver Location',
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/yellow-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingDriverMarker.setPosition(driverPos);
        trackingDriverMarker.setMap(trackingGoogleMap);
      }
    } else if (trackingDriverMarker) {
      trackingDriverMarker.setMap(null);
    }

    if (hasP && hasD) {
      const origin = new google.maps.LatLng(p.lat, p.lng);
      const destination = new google.maps.LatLng(d.lat, d.lng);

      console.log('[LaynRider Map] 🗺️ [TRACKING DIRECTIONS START] Origin: (' + p.lat + ', ' + p.lng + ') -> Dest: (' + d.lat + ', ' + d.lng + ')');

      const request = {
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING
      };

      trackingDirectionsService.route(request, (result, status) => {
        const response = result || {};
        console.log("=== GOOGLE MAPS ROUTE QA LOG ===");
        console.log("API Status Code:", response.status || status);
        if (response.routes && response.routes[0]) {
            const leg = response.routes[0].legs[0];
            console.log("Verification Status: SUCCESS (Using actual road grid)");
            console.log("Total Turn-by-Turn Steps:", leg.steps.length);
            console.log("API Calculated Real Distance:", leg.distance.text, `(${leg.distance.value} meters)`);
        } else {
            console.log("Verification Status: FAILED (Check for coordinate inversion or off-road pins)");
        }
        console.log("================================");

        if (status === google.maps.DirectionsStatus.OK) {
          trackingDirectionsRenderer.setDirections(result);
          const route = result.routes[0];
          const leg = route.legs[0];
          console.log('[LaynRider Map] ✅ [TRACKING DIRECTIONS SUCCESS] ' + leg.distance.text + ', ' + leg.duration.text);

          if (trackingMapRouteInfo) {
            if (trackingMapDistance) trackingMapDistance.textContent = leg.distance.text;
            if (trackingMapDuration) trackingMapDuration.textContent = leg.duration.text;
            trackingMapRouteInfo.classList.remove('is-hidden');
          }

          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          if (hasDriverLoc) bounds.extend(new google.maps.LatLng(driverPresence.lat, driverPresence.lng));
          trackingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        } else {
          console.warn('[LaynRider Map] ⚠️ [TRACKING DIRECTIONS WARN] Status: ' + status);
        }
      });
    }
  }

  global.initGooglePlaces = function () {
    if (!global.google || !global.google.maps || !global.google.maps.places) {
      console.warn('Google Places library not yet ready.');
      return;
    }

    initBookingMap();

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
          updateBookingMap();
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
          if (dropoffClearBtn) dropoffClearBtn.classList.remove('is-hidden');
          updateBookingMap();
        }
      });
    }
  };

  /** ============================================================
   * BOOKING FORM & GEOFENCING IMPLEMENTATION
   * ============================================================ */

  /** Open Booking Form */
  function openBookingForm() {
    if (currentUser && !isProfileComplete) {
      showToast('Add your details to request a ride.');
      openProfileModal();
      return;
    }

    if (currentBookingDoc && ['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'].includes(currentBookingDoc.status)) {
      showToast('You already have an active ride in progress.');
      openActiveTripModal();
      return;
    }

    bookingTargetDriver = null; // Quick Ride (Auto-Dispatch)

    if (bookingTargetTitle) bookingTargetTitle.textContent = 'Quick Ride Auto-Dispatch';
    if (bookingTargetSubtitle) bookingTargetSubtitle.textContent = 'Nearest available driver in Poortjie';
    if (bookingTargetTypeBadge) bookingTargetTypeBadge.textContent = 'Private Car';
    bookingState.vehicleType = 'PRIVATE_CAR';

    setReturnTrip(true);
    setBookingType('ASAP');

    bookingState.actualOneWayDistanceKm = null;
    bookingState.upfrontPrice = null;
    bookingState.estimatedDistanceKm = null;
    bookingState.pickup = { address: '', lat: null, lng: null };
    bookingState.dropoff = { address: '', lat: null, lng: null };

    if (pickupAddressInput) pickupAddressInput.value = '';
    if (pickupClearBtn) pickupClearBtn.classList.add('is-hidden');
    if (pickupGeofenceBadge) {
      pickupGeofenceBadge.className = 'geofence-badge';
      pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
    }
    if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');

    if (dropoffAddressInput) dropoffAddressInput.value = '';
    if (dropoffClearBtn) dropoffClearBtn.classList.add('is-hidden');

    if (bookingNoteInput) bookingNoteInput.value = '';
    if (bookingNoteCount) bookingNoteCount.textContent = '0/64';
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    if (bookingModal) {
      bookingModal.classList.remove('is-hidden');
      updateUpfrontFarePreview(null);
      initBookingMap();
      setTimeout(() => updateBookingMap(), 150);
    }
  }

  function closeBookingModal() {
    if (bookingModal) bookingModal.classList.add('is-hidden');
  }

  /** Open / Close Android App Test Beta Modal */
  function openAppTestModal() {
    if (appTestModal) appTestModal.classList.remove('is-hidden');
  }

  function closeAppTestModal() {
    if (appTestModal) appTestModal.classList.add('is-hidden');
  }

  /** Set Trip Type (Return or Single) */
  function setReturnTrip(isReturn) {
    bookingState.isReturnTrip = isReturn;
    if (toggleTripReturn) toggleTripReturn.classList.toggle('is-active', isReturn);
    if (toggleTripSingle) toggleTripSingle.classList.toggle('is-active', !isReturn);
    updateUpfrontFarePreview();
  }

  /** Set Booking Type (ASAP on Web, or Route to Download App for SCHEDULED) */
  function setBookingType(type) {
    if (type === 'SCHEDULED') {
      window.location.href = 'download.html?feature=scheduled';
      return;
    }
    bookingState.type = 'ASAP';
    if (toggleTypeAsap) toggleTypeAsap.classList.add('is-active');
    if (toggleTypeScheduled) toggleTypeScheduled.classList.remove('is-active');
    if (scheduledFields) scheduledFields.classList.add('is-hidden');
  }

  /** Update pickup coordinates and validate geofence */
  function setPickupLocation(address, lat, lng) {
    const trimmed = (address || '').trim();
    bookingState.actualOneWayDistanceKm = null;
    bookingState.upfrontPrice = null;
    bookingState.estimatedDistanceKm = null;
    bookingState.pickup = { address: trimmed, lat, lng };
    if (pickupAddressInput) pickupAddressInput.value = trimmed;
    if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !trimmed);
    validatePickupGeofence();
    updateBookingMap();
  }

  /** Validate Pickup Geofence */
  function validatePickupGeofence() {
    const lat = bookingState.pickup ? bookingState.pickup.lat : null;
    const lng = bookingState.pickup ? bookingState.pickup.lng : null;

    if (lat == null || lng == null) {
      if (pickupGeofenceBadge) {
        pickupGeofenceBadge.className = 'geofence-badge';
        pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
      }
      if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
      return false;
    }

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

  /** Get GPS Current Position with comprehensive diagnostics, retry fallback, and reverse geocoding */
  async function getGpsLocation() {
    console.log('[GPS] ----------------------------------------------------');
    console.log('[GPS] Starting GPS location request...');
    console.log('[GPS] Environment diagnostics:', {
      hasNavigatorGeolocation: Boolean(navigator && navigator.geolocation),
      isSecureContext: window.isSecureContext,
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      userAgent: navigator.userAgent
    });

    if (!window.isSecureContext && window.location.protocol !== 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      console.warn('[GPS] ⚠️ Page is not running in a secure context (HTTPS/localhost). Geolocation is restricted by modern browsers.');
    }

    if (!navigator.geolocation) {
      console.error('[GPS] ❌ navigator.geolocation is not supported by this browser.');
      showToast('Geolocation is not supported by your browser.');
      return;
    }

    // Check Permissions API if available
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permStatus = await navigator.permissions.query({ name: 'geolocation' });
        console.log(`[GPS] Geolocation permission status: "${permStatus.state}"`);
        permStatus.onchange = () => {
          console.log(`[GPS] Geolocation permission changed to: "${permStatus.state}"`);
        };
      } catch (pErr) {
        console.log('[GPS] Could not query permission status via Permissions API:', pErr);
      }
    }

    if (pickupGpsBtn) {
      pickupGpsBtn.disabled = true;
      pickupGpsBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;"></div> Locating…';
    }

    function resetButton() {
      if (pickupGpsBtn) {
        pickupGpsBtn.disabled = false;
        pickupGpsBtn.innerHTML = '<span>📍</span> GPS';
      }
    }

    function handlePositionSuccess(pos, mode = 'high-accuracy') {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;
      const distToCenter = distanceMeters(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng, lat, lng);
      const allowed = isPickupAllowed(lat, lng);

      console.log(`[GPS] ✅ Position acquired successfully (${mode}):`, {
        latitude: lat,
        longitude: lng,
        accuracyMeters: accuracy,
        distanceToPoortjieCenterMeters: distToCenter.toFixed(1),
        isInsidePoortjie: allowed,
        altitude: pos.coords.altitude,
        speed: pos.coords.speed,
        timestamp: pos.timestamp
      });

      // Attempt reverse geocoding with Google Maps Geocoder if loaded
      if (window.google && window.google.maps && window.google.maps.Geocoder) {
        console.log(`[GPS] Attempting reverse geocoding via Google Maps for (${lat}, ${lng})...`);
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat, lng } }, (results, status) => {
          console.log(`[GPS] Reverse geocode response status: ${status}`, results);
          if (status === 'OK' && results && results[0] && results[0].formatted_address) {
            const formattedAddr = results[0].formatted_address;
            console.log(`[GPS] Resolved address: "${formattedAddr}"`);
            setPickupLocation(formattedAddr, lat, lng);
          } else {
            const fallbackAddr = allowed ? 'Current Location (Poortjie)' : 'Current Location (Outside Area)';
            console.log(`[GPS] Reverse geocoding unfulfilled, using fallback label: "${fallbackAddr}"`);
            setPickupLocation(fallbackAddr, lat, lng);
          }
          if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
          resetButton();
        });
      } else {
        const fallbackAddr = allowed ? 'Current Location (Poortjie)' : 'Current Location (Outside Area)';
        console.log(`[GPS] Google Geocoder not loaded, using fallback label: "${fallbackAddr}"`);
        setPickupLocation(fallbackAddr, lat, lng);
        if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
        resetButton();
      }

      if (allowed) {
        showToast('📍 GPS location within Poortjie captured!');
      } else {
        showToast('⚠️ Your GPS location is outside the Poortjie pickup area.');
      }
    }

    const highAccuracyOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    console.log('[GPS] Invoking navigator.geolocation.getCurrentPosition with high accuracy:', highAccuracyOptions);

    navigator.geolocation.getCurrentPosition(
      (pos) => handlePositionSuccess(pos, 'high-accuracy'),
      (err) => {
        const errorNames = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };
        const errType = errorNames[err.code] || 'UNKNOWN_ERROR';
        console.warn(`[GPS] ⚠️ High-accuracy geolocation failed: code=${err.code} (${errType}), message="${err.message}"`);

        // If high accuracy timed out or was position unavailable, retry once with standard accuracy
        if (err.code === 3 || err.code === 2) {
          console.log('[GPS] Retrying with standard accuracy (enableHighAccuracy: false)...');
          const standardOptions = { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 };
          navigator.geolocation.getCurrentPosition(
            (pos) => handlePositionSuccess(pos, 'standard-accuracy-fallback'),
            (fallbackErr) => {
              const fallbackType = errorNames[fallbackErr.code] || 'UNKNOWN_ERROR';
              console.error(`[GPS] ❌ Standard-accuracy retry also failed: code=${fallbackErr.code} (${fallbackType}), message="${fallbackErr.message}"`);
              if (fallbackErr.code === 2) {
                console.info('[GPS] 💡 Tip for Mac / Chrome DevTools: macOS CoreLocation returned kCLErrorLocationUnknown. To resolve this:\n1. Enable macOS System Settings → Privacy & Security → Location Services → Google Chrome: ON (and ensure Wi-Fi is ON), OR\n2. In Chrome DevTools: Press Cmd+Shift+P → type "Sensors" → set Location to custom coordinates (e.g. Poortjie: Lat -26.45600, Lng 27.77087).');
              }
              resetButton();
              if (fallbackErr.code === 1) {
                showToast('Location permission denied. Please allow location access in your browser.');
              } else if (fallbackErr.code === 2) {
                showToast('GPS position unavailable on your device. Please search an address or check Location Services.');
              } else if (fallbackErr.code === 3) {
                showToast('GPS request timed out. Please search an address manually.');
              } else {
                showToast('Could not retrieve GPS location. Please search an address.');
              }
            },
            standardOptions
          );
        } else {
          resetButton();
          if (err.code === 1) {
            showToast('Location permission denied. Please allow location access in your browser.');
          } else {
            showToast('Could not retrieve GPS location. Please search an address.');
          }
        }
      },
      highAccuracyOptions
    );
  }

  /** Save pending booking state to sessionStorage before redirecting to login */
  function savePendingBookingState() {
    const pendingRide = {
      pickup: {
        address: (bookingState.pickup && bookingState.pickup.address) || (pickupAddressInput ? pickupAddressInput.value.trim() : ''),
        lat: bookingState.pickup ? bookingState.pickup.lat : null,
        lng: bookingState.pickup ? bookingState.pickup.lng : null
      },
      dropoff: {
        address: (bookingState.dropoff && bookingState.dropoff.address) || (dropoffAddressInput ? dropoffAddressInput.value.trim() : ''),
        lat: bookingState.dropoff ? bookingState.dropoff.lat : null,
        lng: bookingState.dropoff ? bookingState.dropoff.lng : null
      },
      note: bookingState.note || (bookingNoteInput ? bookingNoteInput.value.trim() : ''),
      vehicleType: bookingState.vehicleType || 'PRIVATE_CAR',
      isReturnTrip: bookingState.isReturnTrip !== false,
      actualOneWayDistanceKm: bookingState.actualOneWayDistanceKm,
      estimatedDistanceKm: bookingState.estimatedDistanceKm,
      upfrontPrice: bookingState.upfrontPrice,
      ratePerKmSnapshot: bookingState.ratePerKmSnapshot,
      minimumFareSnapshot: bookingState.minimumFareSnapshot,
      returnPercentSnapshot: bookingState.returnPercentSnapshot,
      targetDriverId: bookingTargetDriver ? bookingTargetDriver.uid : null
    };
    try {
      sessionStorage.setItem('pendingRideBooking', JSON.stringify(pendingRide));
    } catch (e) {
      console.warn('Could not store pendingRideBooking in sessionStorage:', e);
    }
  }

  /** Submit Booking */
  async function handleBookingSubmit(e) {
    if (e) e.preventDefault();
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    const pickupAddress = pickupAddressInput ? pickupAddressInput.value.trim() : '';
    if (!pickupAddress) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Please specify a pickup location.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.pickup.address = pickupAddress;

    const dropoffAddress = dropoffAddressInput ? dropoffAddressInput.value.trim() : '';
    if (!dropoffAddress) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Please enter a drop-off destination.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.dropoff.address = dropoffAddress;

    // Geocode missing coordinates if user manually typed address without autocomplete
    if (global.google && global.google.maps && global.google.maps.Geocoder) {
      const geocoder = new google.maps.Geocoder();
      if (!bookingState.pickup.lat || !bookingState.pickup.lng) {
        try {
          const geoRes = await new Promise((resolve) => {
            geocoder.geocode({ address: pickupAddress, componentRestrictions: { country: 'za' } }, (results, status) => {
              if (status === 'OK' && results && results[0] && results[0].geometry) {
                resolve(results[0].geometry.location);
              } else {
                resolve(null);
              }
            });
          });
          if (geoRes) {
            bookingState.pickup.lat = geoRes.lat();
            bookingState.pickup.lng = geoRes.lng();
          }
        } catch (e) {
          console.warn('Geocoding pickup error:', e);
        }
      }

      if (!bookingState.dropoff.lat || !bookingState.dropoff.lng) {
        try {
          const geoRes = await new Promise((resolve) => {
            geocoder.geocode({ address: dropoffAddress, componentRestrictions: { country: 'za' } }, (results, status) => {
              if (status === 'OK' && results && results[0] && results[0].geometry) {
                resolve(results[0].geometry.location);
              } else {
                resolve(null);
              }
            });
          });
          if (geoRes) {
            bookingState.dropoff.lat = geoRes.lat();
            bookingState.dropoff.lng = geoRes.lng();
          }
        } catch (e) {
          console.warn('Geocoding dropoff error:', e);
        }
      }
    }

    if (!validatePickupGeofence()) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Pickup must be inside Poortjie service area (within 1.64 km of town center).';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }

    if (bookingState.actualOneWayDistanceKm == null) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Calculating driving route distance. Please wait a moment.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }

    bookingState.note = (bookingNoteInput ? bookingNoteInput.value.trim() : '');

    // If user is not signed in, save booking state and navigate to login
    if (!currentUser) {
      savePendingBookingState();
      sessionStorage.setItem('redirectUrl', window.location.href);
      window.location.href = '../../authentication/login.html?redirect=' + encodeURIComponent(window.location.href);
      return;
    }

    if (!isProfileComplete) {
      showToast('Add your details to request a ride.');
      closeBookingModal();
      openProfileModal(bookingTargetDriver ? bookingTargetDriver.uid : null);
      return;
    }

    // Open short and friendly confirmation dialog showing details of their ride & 50% test discount
    openConfirmBookingModal();
  }

  /** ============================================================
   * CONFIRMATION DIALOG & DISPATCH
   * ============================================================ */

  /** Open / Close Confirmation Dialog */
  function openConfirmBookingModal() {
    if (confirmModalError) confirmModalError.classList.add('is-hidden');

    const confirmFareText = document.getElementById('confirm-fare-text');
    if (confirmPickupText) confirmPickupText.textContent = bookingState.pickup.address || 'Poortjie';
    if (confirmDropoffText) confirmDropoffText.textContent = bookingState.dropoff.address || 'Destination';
    if (confirmTripType) {
      confirmTripType.textContent = bookingState.isReturnTrip !== false ? 'Return Trip (Round trip)' : 'Single Trip (One way)';
    }
    if (confirmDistanceText) {
      const isReturn = bookingState.isReturnTrip !== false;
      const oneWay = bookingState.actualOneWayDistanceKm ? bookingState.actualOneWayDistanceKm.toFixed(1) : '—';
      confirmDistanceText.textContent = isReturn
        ? `${bookingState.estimatedDistanceKm || '—'} km (${oneWay} km return)`
        : `${bookingState.estimatedDistanceKm || '—'} km`;
    }
    if (confirmFareText) {
      confirmFareText.textContent = typeof bookingState.upfrontPrice === 'number' ? `R ${bookingState.upfrontPrice}` : 'R --';
    }
    if (confirmBookingSubmitBtn) {
      confirmBookingSubmitBtn.innerHTML = typeof bookingState.upfrontPrice === 'number'
        ? `<span>⚡</span> Confirm & Request · R ${bookingState.upfrontPrice}`
        : '<span>⚡</span> Confirm & Request Ride';
    }

    const note = (bookingNoteInput ? bookingNoteInput.value.trim() : '');
    bookingState.note = note;
    if (confirmNoteContainer && confirmNoteText) {
      if (note) {
        confirmNoteText.textContent = note;
        confirmNoteContainer.classList.remove('is-hidden');
      } else {
        confirmNoteContainer.classList.add('is-hidden');
      }
    }

    if (confirmBookingModal) confirmBookingModal.classList.remove('is-hidden');
  }

  function closeConfirmBookingModal() {
    if (confirmBookingModal) confirmBookingModal.classList.add('is-hidden');
  }

  /** Confirm and Dispatch Booking directly to Firestore */
  async function handleConfirmBookingSubmit() {
    if (!currentUser) {
      savePendingBookingState();
      sessionStorage.setItem('redirectUrl', window.location.href);
      window.location.href = '../../authentication/login.html?redirect=' + encodeURIComponent(window.location.href);
      return;
    }

    if (confirmModalError) confirmModalError.classList.add('is-hidden');

    try {
      if (confirmBookingSubmitBtn) {
        confirmBookingSubmitBtn.disabled = true;
        confirmBookingSubmitBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;"></div> Requesting…';
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
        type: 'ASAP',
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
        note: bookingState.note || '',
        vehicleType: bookingState.vehicleType || 'PRIVATE_CAR',
        scheduledTime: null,
        status: 'PENDING',
        driverId: null,
        requestedDriverId: requestedDriverId,
        currentDriverId: null,
        offerExpiresAt: null,
        attemptedDriverIds: [],
        dispatchMessage: 'Finding your ride…',
        deliveredAt: null,
        availabilityEtaMinutes: null,
        priceApproved: true,
        cancelReason: '',
        cancelledByDriver: false,
        events: [initialEvent],
        isReturnTrip: bookingState.isReturnTrip !== false,
        returnPercentSnapshot: bookingState.returnPercentSnapshot || null,
        upfrontPrice: bookingState.upfrontPrice || null,
        ratePerKmSnapshot: bookingState.ratePerKmSnapshot || null,
        minimumFareSnapshot: bookingState.minimumFareSnapshot || null,
        estimatedDistanceKm: bookingState.estimatedDistanceKm || null,
        createdAt: now,
        updatedAt: now
      };

      await bookingsCol.doc(bookingId).set(bookingDocData);

      await ridersCol.doc(currentUser.uid).set({
        uid: currentUser.uid,
        lastRequestedAt: now
      }, { merge: true });

      closeConfirmBookingModal();
      closeBookingModal();
      showToast('🎉 Ride requested! Finding your driver…');
      openActiveTripModal();
    } catch (err) {
      console.error('Failed to create booking:', err);
      if (confirmModalError) {
        confirmModalError.textContent = 'Failed to request ride. Please check your connection and try again.';
        confirmModalError.classList.remove('is-hidden');
      } else {
        showToast('Failed to request ride. Please try again.');
      }
    } finally {
      if (confirmBookingSubmitBtn) {
        confirmBookingSubmitBtn.disabled = false;
        confirmBookingSubmitBtn.innerHTML = '<span>⚡</span> Confirm & Request Ride';
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
            'PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'
          ].includes(it.status));

          const bookingToDisplay = active || list[0];
          const previousStatus = currentBookingDoc ? currentBookingDoc.status : null;
          currentBookingDoc = bookingToDisplay;

          const isLive = active != null;

          // Sound & Toast feedback on Direct Accept transitions
          if (bookingToDisplay.status === 'ACCEPTED' && previousStatus === 'PENDING') {
            playQuoteChime();
            showToast('🎉 Driver accepted your ride!');
            openActiveTripModal();
          } else if (bookingToDisplay.status === 'EN_ROUTE' && previousStatus !== 'EN_ROUTE') {
            showToast('🚗 Driver is on the way to pickup!');
          } else if (bookingToDisplay.status === 'ARRIVED' && previousStatus !== 'ARRIVED') {
            playQuoteChime();
            showToast('📍 Driver has arrived at your pickup location!');
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

  function formatDeclineReason(raw) {
    if (!raw) return '';
    const clean = String(raw)
      .replace(/^Driver declined:\s*/i, '')
      .replace(/^Declined:\s*/i, '')
      .replace(/^Cancelled by driver:\s*/i, '')
      .replace(/^Cancelled by rider:\s*/i, '')
      .replace(/^Cancelled:\s*/i, '')
      .trim();

    switch (clean.toUpperCase()) {
      case 'TOO_FAR':
        return 'Driver was too far from pickup';
      case 'UNKNOWN_RIDER':
        return 'Unrecognized rider / safety concern';
      case 'VEHICLE_FULL':
        return 'Vehicle is currently full';
      case 'SCHEDULED_CONFLICT':
        return 'Scheduled ride conflict';
      case 'OTHER':
        return 'Driver is currently unavailable';
      case 'NO DRIVERS AVAILABLE':
      case 'NO_DRIVERS_AVAILABLE':
      case 'NO_DRIVER':
        return 'No drivers available right now';
      case 'QUOTE APPROVAL TIMED OUT':
      case 'QUOTE_TIMEOUT':
      case 'QUOTE EXPIRED':
        return 'Quote approval timed out';
      case 'RIDER CHANGED PLANS':
      case 'RIDER_CHANGED_PLANS':
        return 'Rider changed plans';
      case 'RIDER NO-SHOW (WAITED 5 MINS)':
      case 'RIDER_NO_SHOW':
        return 'Rider did not show up';
      default:
        return clean;
    }
  }

  /**
   * Resolves the exact human-readable cancellation title, explanation, and badge icon
   * by inspecting booking status, cancelReason, cancelledByDriver, events, and dispatchMessage.
   */
  function getDetailedCancellationInfo(booking) {
    if (!booking) {
      return {
        title: 'Ride Request Ended',
        reason: 'Request ended without confirmation.',
        icon: '❌'
      };
    }

    const status = booking.status || 'CANCELLED';
    const rawReason = (booking.cancelReason || '').trim();
    const dispatchMsg = (booking.dispatchMessage || '').trim();
    const byDriver = booking.cancelledByDriver === true;
    const events = Array.isArray(booking.events) ? booking.events : [];

    // Check audit events for specific timeout or decline entries
    const timeoutEvent = [...events].reverse().find(e => e && (e.event === 'DRIVER_TIMEOUT' || e.event === 'TIMEOUT'));
    const declineEvent = [...events].reverse().find(e => e && e.event === 'DRIVER_DECLINED');
    const noDriverEvent = [...events].reverse().find(e => e && e.event === 'NO_DRIVER_AVAILABLE');

    // 1. Driver cancelled after accepting (Post-Acceptance / En Route / Arrived / In Trip)
    if (byDriver) {
      const readable = formatDeclineReason(rawReason);
      return {
        title: 'Driver Cancelled Ride',
        reason: readable ? `The driver had to cancel: "${readable}"` : 'The driver cancelled this ride after acceptance.',
        icon: '⚠️'
      };
    }

    // 2. Specific Driver or All Drivers Timed Out (didn't respond in 60s)
    if (status === 'DRIVER_UNAVAILABLE' && (timeoutEvent || rawReason.toLowerCase().includes('timed out') || rawReason.toLowerCase().includes('respond'))) {
      return {
        title: 'Driver Did Not Respond in Time',
        reason: 'The driver did not accept or respond within the 60-second window.',
        icon: '⏱️'
      };
    }

    // 3. Driver Declined during review
    if (declineEvent || rawReason.toLowerCase().startsWith('declined:') || rawReason.toLowerCase().includes('declined')) {
      const rawDetail = declineEvent?.detail ? declineEvent.detail.replace(/^Declined:\s*/i, '') : rawReason.replace(/^Declined:\s*/i, '');
      const declineDetail = formatDeclineReason(rawDetail);
      return {
        title: 'Driver Declined Request',
        reason: declineDetail ? `The driver was unable to take your trip: "${declineDetail}".` : 'The driver declined this trip request.',
        icon: '🚫'
      };
    }

    // 4. Chosen driver is offline or busy
    if (status === 'DRIVER_UNAVAILABLE') {
      let detail = rawReason;
      if (!detail && timeoutEvent?.detail) detail = timeoutEvent.detail;
      if (!detail && dispatchMsg) detail = dispatchMsg;
      return {
        title: 'Driver Unavailable',
        reason: detail || 'The requested driver is currently offline or busy on another ride.',
        icon: '🚗'
      };
    }

    // 5. No drivers available in area / exhausted candidates
    if (status === 'CANCELLED_NO_DRIVER') {
      if (timeoutEvent) {
        return {
          title: 'Timed Out',
          reason: 'Nearby driver did not respond within the time limit. Please try requesting again.',
          icon: '⏱️'
        };
      }
      return {
        title: 'No Drivers Available',
        reason: rawReason || noDriverEvent?.detail || 'All available drivers in Poortjie are currently busy or offline. Please try again shortly.',
        icon: '📍'
      };
    }

    // 6. Quote Expired (rider did not approve within 60s)
    if (status === 'CANCELLED_EXPIRED') {
      return {
        title: 'Quote Expired',
        reason: 'The 60-second price quote approval window expired without confirmation.',
        icon: '⏱️'
      };
    }

    // 7. Rider Cancelled
    if (status === 'CANCELLED') {
      if (rawReason.toLowerCase().includes('no_show') || rawReason.toLowerCase().includes('no-show')) {
        return {
          title: 'Cancelled — Rider No-Show',
          reason: 'The driver waited 5 minutes at the pickup location but could not locate you.',
          icon: '📍'
        };
      }
      if (rawReason.toLowerCase().includes('scheduled')) {
        return {
          title: 'Scheduled Ride Cancelled',
          reason: rawReason || 'You cancelled this scheduled ride request.',
          icon: '📅'
        };
      }
      return {
        title: 'Ride Request Cancelled',
        reason: rawReason || 'You cancelled this ride request before confirmation.',
        icon: '✕'
      };
    }

    // Default fallback
    return {
      title: 'Ride Request Ended',
      reason: rawReason || dispatchMsg || 'Request ended without confirmation.',
      icon: '❌'
    };
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
      if (booking.status === 'ACCEPTED' || booking.status === 'EN_ROUTE') activeBookingIcon.textContent = '🚗';
      else if (booking.status === 'ARRIVED') activeBookingIcon.textContent = '📍';
      else if (booking.status === 'IN_TRIP') activeBookingIcon.textContent = '🚀';
      else if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingIcon.textContent = info.icon;
      }
      else activeBookingIcon.textContent = '🚖';
    }

    if (activeBookingTitle) {
      if (booking.status === 'ACCEPTED') {
        const etaMins = booking.availabilityEtaMinutes || 5;
        activeBookingTitle.textContent = `Driver Accepted (ETA ~${etaMins}m)`;
      } else if (booking.status === 'EN_ROUTE') {
        activeBookingTitle.textContent = 'Driver En Route';
      } else if (booking.status === 'ARRIVED') {
        activeBookingTitle.textContent = 'Driver Arrived!';
      } else if (booking.status === 'IN_TRIP') {
        activeBookingTitle.textContent = 'Trip in Progress';
      } else if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingTitle.textContent = info.title;
      } else {
        activeBookingTitle.textContent = 'Finding your ride…';
      }
    }

    if (activeBookingStatusText) {
      if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingStatusText.textContent = info.reason;
      } else {
        activeBookingStatusText.textContent = booking.dispatchMessage || formatBookingStatus(booking.status, booking);
      }
    }
  }

  function formatBookingStatus(status, booking = null) {
    if (booking && ['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(status)) {
      const cancelInfo = getDetailedCancellationInfo(booking);
      return `${cancelInfo.title}: ${cancelInfo.reason}`;
    }
    switch (status) {
      case 'PENDING': return 'Finding your ride / Driver reviewing…';
      case 'ACCEPTED': return 'Driver accepted your ride.';
      case 'EN_ROUTE': return 'Driver is en route to pickup.';
      case 'ARRIVED': return 'Driver has arrived at pickup!';
      case 'IN_TRIP': return 'Heading to drop-off destination.';
      case 'COMPLETED': return 'Trip completed!';
      case 'CANCELLED_NO_DRIVER': return 'No drivers responded in time.';
      case 'DRIVER_UNAVAILABLE': return 'Driver did not respond or declined.';
      case 'CANCELLED_EXPIRED': return 'Ride request expired.';
      case 'CANCELLED': return 'Ride request ended.';
      default: return status || 'In progress';
    }
  }

  /** Render Trip Tracking Details according to status */
  async function renderActiveTripDetails(booking) {
    if (!booking) return;

    if (trackBookingId) trackBookingId.textContent = `#${booking.id}`;

    // Reset all sections
    if (trackPendingSection) trackPendingSection.classList.add('is-hidden');
    if (trackActiveSection) trackActiveSection.classList.add('is-hidden');
    if (trackCompletedSection) trackCompletedSection.classList.add('is-hidden');
    if (trackCancelledSection) trackCancelledSection.classList.add('is-hidden');

    // Clear timers
    if (pendingTimerInterval) { clearInterval(pendingTimerInterval); pendingTimerInterval = null; }

    // Update Stepper
    updateTrackingStepper(booking.status);

    const status = booking.status || 'PENDING';

    if (status === 'PENDING') {
      // 1. Pending Section (Searching / Driver reviewing / Scheduled waiting)
      if (trackPendingSection) trackPendingSection.classList.remove('is-hidden');

      const isScheduled = booking.type === 'SCHEDULED';
      if (isScheduled) {
        if (pendingSectionTitle) pendingSectionTitle.textContent = 'Scheduled Ride Waiting';
        if (pendingSectionDesc) {
          if (booking.scheduledTime) {
            const schedDate = new Date(booking.scheduledTime);
            const dateStr = schedDate.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
            const timeStr = schedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            pendingSectionDesc.textContent = `Scheduled for ${dateStr} at ${timeStr}. Waiting in dispatch queue.`;
          } else {
            pendingSectionDesc.textContent = 'Your ride request is scheduled. Waiting for driver assignment.';
          }
        }
      } else {
        if (pendingSectionTitle) pendingSectionTitle.textContent = 'Finding your ride…';
        if (pendingSectionDesc) {
          pendingSectionDesc.textContent = booking.dispatchMessage || 'Driver is reviewing your request. Please hold on.';
        }
      }

      startPendingCountdown(booking);
      updateCancelPendingButton(booking);
    } else if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP'].includes(status)) {
      // 2. Active En Route / Arrived / In Trip Section (Direct Accept)
      if (trackActiveSection) trackActiveSection.classList.remove('is-hidden');
      await renderDriverInfoForTracking(booking);
    } else if (status === 'COMPLETED') {
      // 3. Completed Section
      if (trackCompletedSection) trackCompletedSection.classList.remove('is-hidden');
      const finalFare = typeof booking.upfrontPrice === 'number'
        ? booking.upfrontPrice.toFixed(2)
        : (typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '0.00');
      const completedFareAmount = document.getElementById('completed-fare-amount');
      if (completedFareAmount) completedFareAmount.textContent = `R ${finalFare}`;

      const completedDistEl = document.getElementById('completed-distance-amount');
      if (completedDistEl) {
        const isReturn = booking.isReturnTrip !== false;
        completedDistEl.textContent = booking.estimatedDistanceKm
          ? `Distance: ${booking.estimatedDistanceKm} km${isReturn ? ' (Return)' : ''}`
          : 'Trip Done';
      }
    } else {
      // 4. Terminal Cancelled / Expired / No Driver
      if (trackCancelledSection) trackCancelledSection.classList.remove('is-hidden');
      const cancelInfo = getDetailedCancellationInfo(booking);
      if (cancelledIcon) cancelledIcon.textContent = cancelInfo.icon;
      if (cancelledTitle) cancelledTitle.textContent = cancelInfo.title;
      if (cancelledReasonText) cancelledReasonText.textContent = cancelInfo.reason;
    }
  }

  /** Update Stepper nodes (Direct Accept Model: Request -> Accepted -> En Route -> In Trip -> Done) */
  function updateTrackingStepper(status) {
    const steps = [
      { el: stepRequested, target: 'PENDING' },
      { el: stepAccepted, target: 'ACCEPTED' },
      { el: stepEnroute, target: 'EN_ROUTE' },
      { el: stepTrip, target: 'IN_TRIP' },
      { el: stepCompleted, target: 'COMPLETED' }
    ];

    const order = ['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'COMPLETED'];
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
   * Update Pending Cancel Button state:
   * - ASAP: users CANNOT cancel when a driver is reviewing the request (deliveredAt != null, currentDriverId != null, or offerExpiresAt != null).
   * - SCHEDULED: users can ONLY cancel when 1 minute (60s) has passed on waiting.
   */
  function updateCancelPendingButton(booking) {
    if (!cancelPendingBtn || !booking) return;

    const isScheduled = booking.type === 'SCHEDULED';

    if (isScheduled) {
      const createdAt = readEpochMillis(booking.createdAt) || Date.now();
      const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
      const waitThresholdSec = 60;

      if (elapsedSec < waitThresholdSec) {
        const remainingSec = waitThresholdSec - elapsedSec;
        cancelPendingBtn.disabled = true;
        cancelPendingBtn.textContent = `Cancel available in ${remainingSec}s`;
        cancelPendingBtn.title = `Scheduled requests can only be cancelled after waiting 1 minute. (${remainingSec}s remaining)`;
      } else {
        cancelPendingBtn.disabled = false;
        cancelPendingBtn.textContent = 'Cancel Request';
        cancelPendingBtn.title = 'Cancel this scheduled ride request';
      }
    } else {
      const isDriverReviewing = Boolean(
        booking.deliveredAt != null ||
        booking.currentDriverId != null ||
        booking.offerExpiresAt != null
      );

      if (isDriverReviewing) {
        cancelPendingBtn.disabled = true;
        cancelPendingBtn.textContent = 'Driver reviewing (cannot cancel)';
        cancelPendingBtn.title = 'A driver is currently reviewing your request. Please wait for their response or 60s timeout.';
      } else {
        cancelPendingBtn.disabled = false;
        cancelPendingBtn.textContent = 'Cancel Request';
        cancelPendingBtn.title = 'Cancel ride request';
      }
    }
  }

  /**
   * Pending countdown — display only, anchored to the server deadline
   * (booking.offerExpiresAt) or scheduled waiting elapsed time.
   * Also updates the cancel button countdown every second.
   */
  function startPendingCountdown(booking) {
    const deadline = readEpochMillis(booking.offerExpiresAt);
    const isScheduled = booking.type === 'SCHEDULED';
    const createdAt = readEpochMillis(booking.createdAt) || Date.now();

    function update() {
      // Dynamically update the cancel button (e.g. countdown 60s for scheduled, driver reviewing for ASAP)
      updateCancelPendingButton(booking);

      if (deadline != null) {
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        const formatted = formatTimerSeconds(remaining);
        if (pendingCountdown) pendingCountdown.textContent = formatted;
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Request timeout in:';
        if (activeBookingCountdownPill) {
          activeBookingCountdownPill.textContent = `⏱️ ${formatted}`;
          activeBookingCountdownPill.classList.remove('is-hidden');
        }
        if (remaining <= 0) {
          clearInterval(pendingTimerInterval);
          pendingTimerInterval = null;
          // Do not write status — the server transitions the booking.
        }
      } else if (isScheduled) {
        const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Waiting time:';
        if (pendingCountdown) pendingCountdown.textContent = formatTimerSeconds(elapsedSec);
        if (activeBookingCountdownPill) {
          activeBookingCountdownPill.textContent = `📅 Waiting (${formatTimerSeconds(elapsedSec)})`;
          activeBookingCountdownPill.classList.remove('is-hidden');
        }
      } else {
        // No live offer yet (still searching). Show the server's message.
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Finding driver:';
        if (pendingCountdown) pendingCountdown.textContent = '…';
        if (activeBookingCountdownPill) activeBookingCountdownPill.classList.add('is-hidden');
      }
    }

    update();
    pendingTimerInterval = setInterval(update, 1000);
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
        const etaMins = booking.availabilityEtaMinutes || 5;
        trackStatusIcon.textContent = '✅';
        trackStatusTitle.textContent = `Driver Accepted (ETA ~${etaMins}m)`;
        trackStatusDesc.textContent = `${name} is preparing to head your way.`;
      } else if (booking.status === 'EN_ROUTE') {
        const etaMins = booking.availabilityEtaMinutes || 5;
        const arrivalDate = new Date(Date.now() + etaMins * 60 * 1000);
        const hh = String(arrivalDate.getHours()).padStart(2, '0');
        const mm = String(arrivalDate.getMinutes()).padStart(2, '0');
        trackStatusIcon.textContent = '🚗';
        trackStatusTitle.textContent = `Driver is En Route (ETA ~${etaMins}m · ${hh}:${mm})`;
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
    const trackFareAmount = document.getElementById('track-fare-amount');
    if (trackFareAmount) {
      const price = typeof booking.upfrontPrice === 'number'
        ? booking.upfrontPrice.toFixed(2)
        : (typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '—');
      trackFareAmount.textContent = `R ${price}`;
    }
    const trackDistanceVal = document.getElementById('track-distance-val');
    if (trackDistanceVal) {
      const isReturn = booking.isReturnTrip !== false;
      trackDistanceVal.textContent = booking.estimatedDistanceKm
        ? `${booking.estimatedDistanceKm} km${isReturn ? ' (Return)' : ''}`
        : '—';
    }

    if (activeBookingCountdownPill) {
      activeBookingCountdownPill.classList.add('is-hidden');
    }

    initTrackingMap();
    setTimeout(() => {
      updateTrackingMap(booking);
    }, 150);
  }

  /** Cancel Pending Request → server (cancelBookingCallable). */
  async function handleCancelPending() {
    if (!currentBookingDoc) return;

    const isScheduled = currentBookingDoc.type === 'SCHEDULED';
    if (isScheduled) {
      const createdAt = readEpochMillis(currentBookingDoc.createdAt) || Date.now();
      const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
      if (elapsedSec < 60) {
        const remaining = 60 - elapsedSec;
        showToast(`Scheduled rides can only be cancelled after waiting 1 minute (${remaining}s remaining).`);
        return;
      }
    } else {
      const isDriverReviewing = Boolean(
        currentBookingDoc.deliveredAt != null ||
        currentBookingDoc.currentDriverId != null ||
        currentBookingDoc.offerExpiresAt != null
      );
      if (isDriverReviewing) {
        showToast('Cannot cancel while a driver is reviewing your request.');
        return;
      }
    }

    try {
      if (cancelPendingBtn) cancelPendingBtn.disabled = true;
      await callFn('cancelBookingCallable', {
        bookingId: currentBookingDoc.id,
        reason: isScheduled
          ? 'Cancelled by rider after 1 min scheduled wait.'
          : 'Cancelled by rider before dispatch confirmation.',
        byDriver: false
      });
      showToast('Ride request cancelled.');
    } catch (err) {
      console.error('Failed to cancel ride:', err);
      showToast('Could not cancel ride.');
    } finally {
      if (cancelPendingBtn && currentBookingDoc) {
        updateCancelPendingButton(currentBookingDoc);
      }
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
            driverTripsCache.delete(driverUid);
            await getDriverTripsCount(driverUid);
          } else {
            const existingDoc = existing.docs[0];
            const existingData = existingDoc.data();
            const elapsed = Date.now() - (existingData.createdAt || 0);
            if (elapsed <= 60000) {
              await ratingsCol.doc(existingDoc.id).update({
                review: comment,
                updatedAt: Date.now()
              });
              driverReviewsCache.delete(driverUid);
            }
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

  /** Resume pending booking saved in sessionStorage before login */
  function checkAndResumePendingBooking() {
    let pendingRaw = null;
    try {
      pendingRaw = sessionStorage.getItem('pendingRideBooking');
    } catch (e) {
      console.warn('Could not read pendingRideBooking from sessionStorage:', e);
    }
    if (!pendingRaw) return;

    let pendingRide = null;
    try {
      pendingRide = JSON.parse(pendingRaw);
    } catch (e) {
      console.warn('Could not parse pendingRideBooking:', e);
      sessionStorage.removeItem('pendingRideBooking');
      return;
    }

    if (!pendingRide || !pendingRide.pickup || !pendingRide.dropoff) {
      sessionStorage.removeItem('pendingRideBooking');
      return;
    }

    // Restore booking state
    bookingState.pickup = pendingRide.pickup || { address: '', lat: null, lng: null };
    bookingState.dropoff = pendingRide.dropoff || { address: '', lat: null, lng: null };
    bookingState.note = pendingRide.note || '';
    bookingState.vehicleType = pendingRide.vehicleType || 'PRIVATE_CAR';
    bookingState.isReturnTrip = pendingRide.isReturnTrip !== false;
    bookingState.actualOneWayDistanceKm = pendingRide.actualOneWayDistanceKm || null;
    bookingState.estimatedDistanceKm = pendingRide.estimatedDistanceKm || null;
    bookingState.upfrontPrice = pendingRide.upfrontPrice || null;
    bookingState.ratePerKmSnapshot = pendingRide.ratePerKmSnapshot || null;
    bookingState.minimumFareSnapshot = pendingRide.minimumFareSnapshot || null;
    bookingState.returnPercentSnapshot = pendingRide.returnPercentSnapshot || null;
    bookingTargetDriver = pendingRide.targetDriverId ? { uid: pendingRide.targetDriverId } : null;

    // Populate UI inputs
    if (pickupAddressInput) pickupAddressInput.value = bookingState.pickup.address || '';
    if (dropoffAddressInput) dropoffAddressInput.value = bookingState.dropoff.address || '';
    if (bookingNoteInput) bookingNoteInput.value = bookingState.note || '';
    if (bookingNoteCount) bookingNoteCount.textContent = `${(bookingState.note || '').length}/64`;
    if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !bookingState.pickup.address);
    if (dropoffClearBtn) dropoffClearBtn.classList.toggle('is-hidden', !bookingState.dropoff.address);

    setReturnTrip(bookingState.isReturnTrip);
    validatePickupGeofence();
    updateUpfrontFarePreview(bookingState.actualOneWayDistanceKm);

    // If profile is NOT complete, prompt user to complete profile details first
    if (!isProfileComplete) {
      showToast('Please complete your profile to continue with your ride booking.', 4000);
      openProfileModal(pendingRide.targetDriverId || null);
    } else {
      // Profile is complete! Automatically open confirmation dialog to continue booking
      sessionStorage.removeItem('pendingRideBooking');
      showToast('Continuing with your ride request...', 3000);
      setTimeout(() => {
        openConfirmBookingModal();
      }, 300);
    }
  }

  /** Render user state */
  function renderUserState(authUser, profileData) {
    if (!authUser) {
      currentUser = null;
      userProfile = null;
      isProfileComplete = false;
      if (driverListenersUnsub) { driverListenersUnsub(); driverListenersUnsub = null; }
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }

      if (headerSignInBtn) headerSignInBtn.classList.remove('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.add('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.add('is-hidden');

      if (heroNameEl) heroNameEl.textContent = 'rider';
      if (profileIncompleteBanner) profileIncompleteBanner.classList.add('is-hidden');
      if (activeBookingBanner) activeBookingBanner.classList.add('is-hidden');

      showView('app');
      return;
    }

    currentUser = authUser;
    userProfile = profileData || {};

    if (userProfile.suspended === true) {
      const reasonEl = document.getElementById('suspended-reason-text');
      if (reasonEl) {
        reasonEl.textContent = userProfile.suspendedReason || 'Account suspended by management.';
      }
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
    startActiveBookingListener(authUser.uid);

    // Check if there is a pending ride booking from before login
    checkAndResumePendingBooking();
  }

  /** Sign Out */
  async function handleSignOut() {
    try {
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

    if (completeProfileBtn) completeProfileBtn.addEventListener('click', () => openProfileModal());
    if (headerUserBtn) headerUserBtn.addEventListener('click', () => openProfileModal());

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
    if (quickRideBtn) quickRideBtn.addEventListener('click', () => openBookingForm());

    // Booking Modal
    if (bookingModalClose) bookingModalClose.addEventListener('click', closeBookingModal);
    if (bookingModalCancel) bookingModalCancel.addEventListener('click', closeBookingModal);
    if (bookingForm) bookingForm.addEventListener('submit', handleBookingSubmit);

    // Trip Type Toggles
    if (toggleTripReturn) toggleTripReturn.addEventListener('click', () => setReturnTrip(true));
    if (toggleTripSingle) toggleTripSingle.addEventListener('click', () => setReturnTrip(false));

    // Ride Type Toggles
    if (toggleTypeAsap) toggleTypeAsap.addEventListener('click', () => setBookingType('ASAP'));
    if (toggleTypeScheduled) toggleTypeScheduled.addEventListener('click', () => setBookingType('SCHEDULED'));

    // GPS Pickup
    if (pickupGpsBtn) pickupGpsBtn.addEventListener('click', getGpsLocation);

    // Clear Pickup Input Button
    if (pickupClearBtn) {
      pickupClearBtn.addEventListener('click', () => {
        if (pickupAddressInput) {
          pickupAddressInput.value = '';
          pickupAddressInput.focus();
        }
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.pickup = { address: '', lat: null, lng: null };
        pickupClearBtn.classList.add('is-hidden');
        if (pickupGeofenceBadge) {
          pickupGeofenceBadge.className = 'geofence-badge';
          pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
        }
        if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
        updateBookingMap();
      });
    }

    // Clear Drop-off Input Button
    if (dropoffClearBtn) {
      dropoffClearBtn.addEventListener('click', () => {
        if (dropoffAddressInput) {
          dropoffAddressInput.value = '';
          dropoffAddressInput.focus();
        }
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.dropoff = { address: '', lat: null, lng: null };
        dropoffClearBtn.classList.add('is-hidden');
        updateBookingMap();
      });
    }

    // Quick Preset Chips (Pickup & Dropoff)
    const presetChips = document.querySelectorAll('.preset-chip');
    presetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const target = chip.getAttribute('data-target');
        const val = chip.getAttribute('data-val') || '';
        const lat = parseFloat(chip.getAttribute('data-lat')) || SERVICE_AREA.center.lat;
        const lng = parseFloat(chip.getAttribute('data-lng')) || SERVICE_AREA.center.lng;

        if (target === 'pickup') {
          setPickupLocation(val, lat, lng);
          if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
        } else if (target === 'dropoff') {
          bookingState.actualOneWayDistanceKm = null;
          bookingState.upfrontPrice = null;
          bookingState.estimatedDistanceKm = null;
          bookingState.dropoff = { address: val, lat, lng };
          if (dropoffAddressInput) {
            dropoffAddressInput.value = val;
            if (dropoffClearBtn) dropoffClearBtn.classList.remove('is-hidden');
          }
          updateBookingMap();
        }
      });
    });

    // Helper to geocode manual text inputs on blur/change
    function tryGeocodeField(field) {
      if (!global.google || !global.google.maps || !global.google.maps.Geocoder) return;
      const geocoder = new google.maps.Geocoder();
      if (field === 'pickup') {
        const addr = (pickupAddressInput ? pickupAddressInput.value : '').trim();
        if (!addr || (bookingState.pickup.lat && bookingState.pickup.lng)) return;
        geocoder.geocode({ address: addr, componentRestrictions: { country: 'za' } }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].geometry) {
            const loc = results[0].geometry.location;
            setPickupLocation(results[0].formatted_address || addr, loc.lat(), loc.lng());
          }
        });
      } else if (field === 'dropoff') {
        const addr = (dropoffAddressInput ? dropoffAddressInput.value : '').trim();
        if (!addr || (bookingState.dropoff.lat && bookingState.dropoff.lng)) return;
        geocoder.geocode({ address: addr, componentRestrictions: { country: 'za' } }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].geometry) {
            const loc = results[0].geometry.location;
            bookingState.actualOneWayDistanceKm = null;
            bookingState.upfrontPrice = null;
            bookingState.estimatedDistanceKm = null;
            bookingState.dropoff = { address: results[0].formatted_address || addr, lat: loc.lat(), lng: loc.lng() };
            updateBookingMap();
          }
        });
      }
    }

    // Pickup input manual change & select on focus
    if (pickupAddressInput) {
      pickupAddressInput.addEventListener('input', () => {
        const val = pickupAddressInput.value;
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.pickup.address = val;
        if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !val.trim());
        bookingState.pickup.lat = null;
        bookingState.pickup.lng = null;
        if (pickupGeofenceBadge) {
          pickupGeofenceBadge.className = 'geofence-badge';
          pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
        }
        if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
        updateBookingMap();
      });

      pickupAddressInput.addEventListener('change', () => tryGeocodeField('pickup'));

      // If user focuses pickup while GPS text is present, select all for instant 1-key replacement
      pickupAddressInput.addEventListener('focus', () => {
        if (pickupAddressInput.value && pickupAddressInput.value.startsWith('Current GPS Location')) {
          pickupAddressInput.select();
        }
      });
    }

    // Dropoff input manual change
    if (dropoffAddressInput) {
      dropoffAddressInput.addEventListener('input', () => {
        const val = dropoffAddressInput.value;
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.dropoff.address = val;
        if (dropoffClearBtn) dropoffClearBtn.classList.toggle('is-hidden', !val.trim());
        bookingState.dropoff.lat = null;
        bookingState.dropoff.lng = null;
        updateBookingMap();
      });

      dropoffAddressInput.addEventListener('change', () => tryGeocodeField('dropoff'));
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
    if (completedDoneBtn) completedDoneBtn.addEventListener('click', handleCompletedDone);
    if (cancelledDismissBtn) cancelledDismissBtn.addEventListener('click', closeActiveTripModal);

    // App Test Modal
    if (appTestModalClose) appTestModalClose.addEventListener('click', closeAppTestModal);
    if (appTestModalCancel) appTestModalCancel.addEventListener('click', closeAppTestModal);
    if (appTestModal) {
      appTestModal.addEventListener('click', (e) => {
        if (e.target === appTestModal) closeAppTestModal();
      });
    }

    // Confirm Booking Modal
    if (confirmBookingModalClose) confirmBookingModalClose.addEventListener('click', closeConfirmBookingModal);
    if (confirmBookingBackBtn) confirmBookingBackBtn.addEventListener('click', closeConfirmBookingModal);
    if (confirmBookingSubmitBtn) confirmBookingSubmitBtn.addEventListener('click', handleConfirmBookingSubmit);
    if (confirmBookingModal) {
      confirmBookingModal.addEventListener('click', (e) => {
        if (e.target === confirmBookingModal) closeConfirmBookingModal();
      });
    }

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
    initPricingRatesListener();

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
    openBookingForm,
    openConfirmBookingModal,
    closeConfirmBookingModal,
    openAppTestModal,
    closeAppTestModal,
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
