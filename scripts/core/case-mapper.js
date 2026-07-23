/**
 * case-mapper.js — Deep snake_case <-> camelCase key conversion.
 *
 * The single place the app translates between the Firestore storage convention
 * (snake_case) and the JS/domain convention (camelCase). Keeping this at the
 * Model boundary lets the rest of the web app speak camelCase everywhere while
 * the database is migrated (or not) at its own pace.
 *
 * Only plain objects and arrays are recursed into. Special values such as
 * Firestore Timestamps, Dates, and other class instances are passed through
 * untouched so we never corrupt them.
 */
(function (global) {
    'use strict';

    const snakeToCamel = (key) =>
        key.replace(/_+([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());

    const camelToSnake = (key) =>
        key.replace(/([A-Z])/g, (ch) => '_' + ch.toLowerCase());

    // A "plain" object is a bare {} — not a Date, Timestamp, or other class.
    const isPlainObject = (value) => {
        if (value === null || typeof value !== 'object') return false;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    };

    function convertKeys(input, keyFn) {
        if (Array.isArray(input)) {
            return input.map((item) => convertKeys(item, keyFn));
        }
        if (isPlainObject(input)) {
            return Object.keys(input).reduce((acc, key) => {
                acc[keyFn(key)] = convertKeys(input[key], keyFn);
                return acc;
            }, {});
        }
        return input;
    }

    const keysToCamel = (obj) => convertKeys(obj, snakeToCamel);
    const keysToSnake = (obj) => convertKeys(obj, camelToSnake);

    global.CaseMapper = { snakeToCamel, camelToSnake, keysToCamel, keysToSnake };
})(window);
