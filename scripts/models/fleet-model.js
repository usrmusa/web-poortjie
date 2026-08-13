/**
 * fleet-model.js — The "Model" for the Fleet subscription feature.
 *
 * This is NOT an Uber/Bolt-style on-demand ride. It models RECURRING transport
 * subscriptions billed weekly or monthly — e.g. a parent subscribing their kids
 * to a school shuttle, or a company putting staff on a daily commute plan.
 *
 * Everything here is pure data + pure functions (no DOM, no Firebase) so it can
 * be unit-tested and reused by any ViewModel/View. Mock data lives here too so
 * the whole experience previews without a backend or login.
 */
(function (global) {
    'use strict';

    // -------------------------------------------------------------------------
    // Reference data
    // -------------------------------------------------------------------------

    // The kind of fleet a customer is booking. Drives copy + which fields show.
    const FLEET_TYPES = {
        school: {
            id: 'school',
            label: 'School Fleet',
            tagline: 'Daily school runs for learners',
            icon: 'fa-graduation-cap',
            riderNoun: 'Learner',
            examplePickup: 'Home / Ext 4',
            exampleDestination: 'Riverside Primary'
        },
        staff: {
            id: 'staff',
            label: 'Staff Fleet',
            tagline: 'Reliable commute for your team',
            icon: 'fa-briefcase',
            riderNoun: 'Employee',
            examplePickup: 'Kliptown pickup point',
            exampleDestination: 'Industrial Park'
        },
        group: {
            id: 'group',
            label: 'Group / Custom',
            tagline: 'Church, sports club, or any regular group',
            icon: 'fa-people-group',
            riderNoun: 'Member',
            examplePickup: 'Community hall',
            exampleDestination: 'Destination'
        }
    };

    // Vehicle classes. costPerKmPerSeat feeds the recurring quote.
    const VEHICLE_CLASSES = {
        tuktuk: { id: 'tuktuk', label: 'TukTuk', capacity: 3, icon: 'fa-motorcycle', costPerKmPerSeat: 3.0 },
        sedan: { id: 'sedan', label: 'Sedan', capacity: 4, icon: 'fa-car-side', costPerKmPerSeat: 2.5 },
        minibus: { id: 'minibus', label: 'Minibus / Quantum', capacity: 15, icon: 'fa-van-shuttle', costPerKmPerSeat: 1.6 },
        bus: { id: 'bus', label: 'Bus', capacity: 22, icon: 'fa-bus', costPerKmPerSeat: 1.2 }
    };

    const BILLING_CYCLES = {
        weekly: { id: 'weekly', label: 'Weekly', per: '/week' },
        monthly: { id: 'monthly', label: 'Monthly', per: '/month', discount: 0.10 }
    };

    // Mon–Sun. `short` used in chips, `index` matches Date.getDay() Sun=0.
    const WEEK_DAYS = [
        { id: 'mon', short: 'Mon', label: 'Monday', index: 1 },
        { id: 'tue', short: 'Tue', label: 'Tuesday', index: 2 },
        { id: 'wed', short: 'Wed', label: 'Wednesday', index: 3 },
        { id: 'thu', short: 'Thu', label: 'Thursday', index: 4 },
        { id: 'fri', short: 'Fri', label: 'Friday', index: 5 },
        { id: 'sat', short: 'Sat', label: 'Saturday', index: 6 },
        { id: 'sun', short: 'Sun', label: 'Sunday', index: 0 }
    ];

    // Weeks per month (average) used to convert weekly -> monthly.
    const WEEKS_PER_MONTH = 4.33;

    // -------------------------------------------------------------------------
    // Quote calculator (pure)
    // -------------------------------------------------------------------------

    /**
     * Calculate a recurring transport quote.
     * @param {object} input
     *   distanceKm   {number} one-way distance in km
     *   seats        {number} number of riders / seats booked
     *   vehicleClass {string} key into VEHICLE_CLASSES
     *   days         {string[]} selected WEEK_DAYS ids
     *   roundTrip    {boolean} true = there AND back each day (2 trips/day)
     * @returns {object} { tripsPerWeek, perSeatWeekly, weekly, monthly, monthlySaving, valid }
     */
    function calculateQuote(input) {
        const vehicle = VEHICLE_CLASSES[input.vehicleClass] || VEHICLE_CLASSES.minibus;
        const distanceKm = Math.max(0, Number(input.distanceKm) || 0);
        const seats = Math.max(0, Math.floor(Number(input.seats) || 0));
        const dayCount = Array.isArray(input.days) ? input.days.length : 0;
        const directionsPerDay = input.roundTrip ? 2 : 1;
        const tripsPerWeek = dayCount * directionsPerDay;

        const perSeatWeekly = distanceKm * vehicle.costPerKmPerSeat * tripsPerWeek;
        const weekly = perSeatWeekly * seats;

        const monthlyGross = weekly * WEEKS_PER_MONTH;
        const discount = BILLING_CYCLES.monthly.discount || 0;
        const monthly = monthlyGross * (1 - discount);
        const monthlySaving = monthlyGross - monthly;

        return {
            tripsPerWeek,
            perSeatWeekly: round2(perSeatWeekly),
            weekly: round2(weekly),
            monthly: round2(monthly),
            monthlySaving: round2(monthlySaving),
            valid: distanceKm > 0 && seats > 0 && tripsPerWeek > 0
        };
    }

    /** Price shown for a given cycle. */
    function priceForCycle(quote, cycle) {
        return cycle === 'weekly' ? quote.weekly : quote.monthly;
    }

    function round2(n) {
        return Math.round((n + Number.EPSILON) * 100) / 100;
    }

    /** Format a number as South African Rand. */
    function formatZar(amount) {
        return 'R' + (Number(amount) || 0).toLocaleString('en-ZA', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    // -------------------------------------------------------------------------
    // Mock data — available fleets you can subscribe to (operator listings)
    // -------------------------------------------------------------------------

    const MOCK_AVAILABLE_FLEETS = [
        {
            id: 'flt_bafana_school',
            name: 'Bafana School Shuttle',
            operator: 'Bafana Transport CC',
            fleetType: 'school',
            vehicleClass: 'minibus',
            pickupArea: 'Zone 6, Kliptown',
            destination: 'Riverside Primary School',
            distanceKm: 7,
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            roundTrip: true,
            departTime: '06:45',
            returnTime: '14:30',
            seatsAvailable: 4,
            monthlyPrice: 780,
            rating: 4.8,
            verified: true,
            badge: 'Popular'
        },
        {
            id: 'flt_kasi_staff',
            name: 'Kasi Staff Express',
            operator: 'Mahlangu Fleet Services',
            fleetType: 'staff',
            vehicleClass: 'bus',
            pickupArea: 'Extension 4 Taxi Rank',
            destination: 'Chamdor Industrial Park',
            distanceKm: 14,
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
            roundTrip: true,
            departTime: '05:30',
            returnTime: '17:15',
            seatsAvailable: 9,
            monthlyPrice: 1150,
            rating: 4.6,
            verified: true,
            badge: 'Best value'
        },
        {
            id: 'flt_little_stars',
            name: 'Little Stars Transport',
            operator: 'Dlamini Sisters',
            fleetType: 'school',
            vehicleClass: 'sedan',
            pickupArea: 'Toekomsrus',
            destination: 'Bright Future College',
            distanceKm: 5,
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            roundTrip: true,
            departTime: '07:00',
            returnTime: '13:45',
            seatsAvailable: 2,
            monthlyPrice: 690,
            rating: 4.9,
            verified: true,
            badge: 'Top rated'
        },
        {
            id: 'flt_night_shift',
            name: 'Night Shift Movers',
            operator: 'Sibanda Logistics',
            fleetType: 'staff',
            vehicleClass: 'minibus',
            pickupArea: 'Simunye',
            destination: 'Westgate Mall (Retail Hub)',
            distanceKm: 11,
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            roundTrip: true,
            departTime: '21:00',
            returnTime: '06:00',
            seatsAvailable: 6,
            monthlyPrice: 1320,
            rating: 4.4,
            verified: false,
            badge: null
        },
        {
            id: 'flt_church_run',
            name: 'Sunday Grace Run',
            operator: 'Grace Community Trust',
            fleetType: 'group',
            vehicleClass: 'bus',
            pickupArea: 'Bekkersdal',
            destination: 'Grace Ministries, CBD',
            distanceKm: 9,
            days: ['sun'],
            roundTrip: true,
            departTime: '08:00',
            returnTime: '12:30',
            seatsAvailable: 15,
            monthlyPrice: 240,
            rating: 4.7,
            verified: true,
            badge: null
        }
    ];

    // -------------------------------------------------------------------------
    // Mock data — the current user's existing subscriptions
    // -------------------------------------------------------------------------

    const MOCK_MY_SUBSCRIPTIONS = [
        {
            id: 'sub_001',
            fleetName: 'Bafana School Shuttle',
            fleetType: 'school',
            vehicleClass: 'minibus',
            pickup: 'Zone 6, Kliptown',
            destination: 'Riverside Primary School',
            billingCycle: 'monthly',
            amount: 1560,
            status: 'active',
            riders: ['Lerato M.', 'Karabo M.'],
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            departTime: '06:45',
            returnTime: '14:30',
            nextBillingDate: '2026-08-01',
            startedOn: '2026-01-15'
        },
        {
            id: 'sub_002',
            fleetName: 'Kasi Staff Express',
            fleetType: 'staff',
            vehicleClass: 'bus',
            pickup: 'Extension 4 Taxi Rank',
            destination: 'Chamdor Industrial Park',
            billingCycle: 'monthly',
            amount: 1150,
            status: 'pending',
            riders: ['You'],
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
            departTime: '05:30',
            returnTime: '17:15',
            nextBillingDate: '2026-08-05',
            startedOn: '2026-07-20'
        },
        {
            id: 'sub_003',
            fleetName: 'Sunday Grace Run',
            fleetType: 'group',
            vehicleClass: 'bus',
            pickup: 'Bekkersdal',
            destination: 'Grace Ministries, CBD',
            billingCycle: 'weekly',
            amount: 60,
            status: 'paused',
            riders: ['Gogo Ndlovu', 'You', '+2'],
            days: ['sun'],
            departTime: '08:00',
            returnTime: '12:30',
            nextBillingDate: '—',
            startedOn: '2025-11-02'
        }
    ];

    global.FleetModel = {
        FLEET_TYPES,
        VEHICLE_CLASSES,
        BILLING_CYCLES,
        WEEK_DAYS,
        WEEKS_PER_MONTH,
        calculateQuote,
        priceForCycle,
        formatZar,
        MOCK_AVAILABLE_FLEETS,
        MOCK_MY_SUBSCRIPTIONS
    };
})(typeof window !== 'undefined' ? window : globalThis);
