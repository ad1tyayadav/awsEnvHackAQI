// Tests for AQI math: every band edge, interpolation midpoints, cap, invalid input.
import { test, expect } from 'vitest';
import { pm25ToAqi } from '../lib/aqi';

test('band edges map exactly', () => {
  expect(pm25ToAqi(0)).toEqual({ aqi: 0, category: 'Good' });
  expect(pm25ToAqi(30).aqi).toBe(50);
  expect(pm25ToAqi(31).aqi).toBe(51);
  expect(pm25ToAqi(60).aqi).toBe(100);
  expect(pm25ToAqi(61).aqi).toBe(101);
  expect(pm25ToAqi(90).aqi).toBe(200);
  expect(pm25ToAqi(91).aqi).toBe(201);
  expect(pm25ToAqi(120).aqi).toBe(300);
  expect(pm25ToAqi(121).aqi).toBe(301);
  expect(pm25ToAqi(250).aqi).toBe(400);
});

test('interpolation midpoint: PM2.5 = 45 -> AQI ~= 75 (PRD example)', () => {
  expect(pm25ToAqi(45).aqi).toBe(75);
});

test('zero, high and capped values', () => {
  expect(pm25ToAqi(0).category).toBe('Good');
  expect(pm25ToAqi(300).aqi).toBeGreaterThan(400);
  expect(pm25ToAqi(300).aqi).toBeLessThanOrEqual(500);
  expect(pm25ToAqi(1000).aqi).toBe(500); // hard cap
  expect(pm25ToAqi(1000).category).toBe('Severe');
});

test('categories per band', () => {
  expect(pm25ToAqi(15).category).toBe('Good');
  expect(pm25ToAqi(45).category).toBe('Satisfactory');
  expect(pm25ToAqi(75).category).toBe('Moderate');
  expect(pm25ToAqi(100).category).toBe('Poor');
  expect(pm25ToAqi(150).category).toBe('Very Poor');
  expect(pm25ToAqi(300).category).toBe('Severe');
});

test('negative and non-numeric input throws RangeError', () => {
  expect(() => pm25ToAqi(-1)).toThrow(RangeError);
  expect(() => pm25ToAqi(Number.NaN)).toThrow(RangeError);
});

test('251 continues ramp above 401', () => {
  expect(pm25ToAqi(251).aqi).toBe(401);
});
