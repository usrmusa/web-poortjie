/**
 * fleet-view-model.js — The "ViewModel" for the Fleet subscription feature.
 *
 * Owns all state and business actions for the Book-a-Fleet page. The View (HTML)
 * only reads state and calls actions; it never computes prices or mutates data
 * directly. Built on the same reactive `Store` used by AuthStore.
 *
 * Depends on: scripts/core/observable.js (Store), scripts/models/fleet-model.js
 */
(function (global) {
    'use strict';

    const M = global.FleetModel;

    function defaultForm() {
        return {
            fleetType: 'school',
            vehicleClass: 'minibus',
            billingCycle: 'monthly',
            pickup: '',
            destination: '',
            distanceKm: 7,
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            roundTrip: true,
            departTime: '06:45',
            returnTime: '14:30',
            seats: 1,
            riders: [],
            contactName: '',
            contactPhone: '',
            notes: ''
        };
    }

    function initialState() {
        const form = defaultForm();
        return {
            // Which screen is showing: 'browse' | 'build' | 'plans'
            tab: 'browse',
            filterType: 'all',
            form,
            quote: M.calculateQuote(form),
            availableFleets: M.MOCK_AVAILABLE_FLEETS.slice(),
            mySubscriptions: M.MOCK_MY_SUBSCRIPTIONS.slice(),
            lastConfirmation: null // set after a successful (mock) subscribe
        };
    }

    const store = new global.Store(initialState());

    // --- helpers -------------------------------------------------------------

    function recompute(patch) {
        // Merge form patch, then recalculate the quote from the new form.
        store.setState((prev) => {
            const form = Object.assign({}, prev.form, patch);
            return { form, quote: M.calculateQuote(form) };
        });
    }

    // --- actions -------------------------------------------------------------

    const actions = {
        setTab(tab) {
            store.setState({ tab });
        },

        setFilterType(filterType) {
            store.setState({ filterType });
        },

        setFleetType(fleetType) {
            recompute({ fleetType });
        },

        setVehicleClass(vehicleClass) {
            recompute({ vehicleClass });
        },

        setBillingCycle(billingCycle) {
            store.setState({ form: Object.assign({}, store.getState().form, { billingCycle }) });
        },

        setField(field, value) {
            recompute({ [field]: value });
        },

        toggleDay(dayId) {
            const days = store.getState().form.days.slice();
            const idx = days.indexOf(dayId);
            if (idx >= 0) days.splice(idx, 1);
            else days.push(dayId);
            recompute({ days });
        },

        toggleRoundTrip() {
            recompute({ roundTrip: !store.getState().form.roundTrip });
        },

        setSeats(n) {
            recompute({ seats: Math.max(1, Math.floor(Number(n) || 1)) });
        },

        addRider(name) {
            const clean = (name || '').trim();
            if (!clean) return;
            const riders = store.getState().form.riders.concat(clean);
            // Seats should never be fewer than named riders.
            const seats = Math.max(store.getState().form.seats, riders.length);
            recompute({ riders, seats });
        },

        removeRider(index) {
            const riders = store.getState().form.riders.slice();
            riders.splice(index, 1);
            recompute({ riders });
        },

        /** Pre-fill the builder from an available fleet listing, then jump to it. */
        prefillFromFleet(fleetId) {
            const fleet = store.getState().availableFleets.find((f) => f.id === fleetId);
            if (!fleet) return;
            const form = Object.assign(defaultForm(), {
                fleetType: fleet.fleetType,
                vehicleClass: fleet.vehicleClass,
                pickup: fleet.pickupArea,
                destination: fleet.destination,
                distanceKm: fleet.distanceKm,
                days: fleet.days.slice(),
                roundTrip: fleet.roundTrip,
                departTime: fleet.departTime,
                returnTime: fleet.returnTime,
                seats: 1
            });
            store.setState({ tab: 'build', form, quote: M.calculateQuote(form), lastConfirmation: null });
        },

        /**
         * "Submit" a subscription. This is mock: it just prepends a new entry to
         * mySubscriptions and records a confirmation so the View can celebrate.
         * Wire to Firestore later without changing the View.
         */
        submitSubscription() {
            const s = store.getState();
            const form = s.form;
            const q = s.quote;
            if (!q.valid) {
                return { ok: false, error: 'Please complete pickup, drop-off, seats and travel days.' };
            }
            const amount = M.priceForCycle(q, form.billingCycle);
            const fleetTypeLabel = M.FLEET_TYPES[form.fleetType] ? M.FLEET_TYPES[form.fleetType].label : 'Fleet';
            const newSub = {
                id: 'sub_' + Date.now(),
                fleetName: form.destination ? (form.destination + ' Run') : fleetTypeLabel,
                fleetType: form.fleetType,
                vehicleClass: form.vehicleClass,
                pickup: form.pickup || '—',
                destination: form.destination || '—',
                billingCycle: form.billingCycle,
                amount,
                status: 'pending',
                riders: form.riders.length ? form.riders.slice() : ['You'],
                days: form.days.slice(),
                departTime: form.departTime,
                returnTime: form.returnTime,
                nextBillingDate: nextBillingDate(form.billingCycle),
                startedOn: today()
            };
            const confirmation = { amount, cycle: form.billingCycle, subscription: newSub };
            store.setState((prev) => ({
                mySubscriptions: [newSub].concat(prev.mySubscriptions),
                lastConfirmation: confirmation,
                tab: 'plans'
            }));
            return { ok: true, confirmation };
        },

        updateSubscriptionStatus(id, status) {
            store.setState((prev) => ({
                mySubscriptions: prev.mySubscriptions.map((sub) =>
                    sub.id === id ? Object.assign({}, sub, { status }) : sub)
            }));
        },

        clearConfirmation() {
            store.setState({ lastConfirmation: null });
        },

        reset() {
            const form = defaultForm();
            store.setState({ form, quote: M.calculateQuote(form), lastConfirmation: null });
        }
    };

    function today() {
        return new Date().toISOString().slice(0, 10);
    }

    function nextBillingDate(cycle) {
        const d = new Date();
        if (cycle === 'weekly') d.setDate(d.getDate() + 7);
        else d.setMonth(d.getMonth() + 1);
        return d.toISOString().slice(0, 10);
    }

    global.FleetViewModel = {
        store,
        subscribe: (fn, opts) => store.subscribe(fn, opts),
        getState: () => store.getState(),
        actions
    };
})(typeof window !== 'undefined' ? window : globalThis);
