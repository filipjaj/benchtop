/*
 * Luft: behaviour from project.json
 *
 * Read the BME280 every 10 seconds. Show temperature large, with humidity and pressure below. A button press cycles: now, 24 hour temperature trend, 24 hour pressure trend. Dim the display after 60 seconds without a press.
 *
 * Pin numbers come only from pins.h. Run the bring-up environment first:
 *   pio run -e bringup -t upload
 *
 * STATUS: compiles with `pio run -e main` (espressif32 8.0.0, 381 KB). It has NOT
 * been run on hardware: treat the first flash as the test.
 *
 * Design notes
 * - The sensor runs in forced mode, one sample every 10 s, then sleeps. That keeps
 *   its own heating out of the temperature reading.
 * - The 24 hour trend is 128 points, one per display column, each the average of
 *   11 min 15 s of readings. It lives in RAM: unplugging the device clears it.
 * - A press while the display is dimmed only wakes it. The next press changes view.
 * - Wi-Fi and Bluetooth are never started, so the board stays cool next to the sensor.
 */
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_BME280.h>
#include "pins.h"

namespace {

constexpr int16_t SCREEN_W = 128;
constexpr int16_t SCREEN_H = 64;

constexpr uint32_t READ_INTERVAL_MS = 10UL * 1000UL;
constexpr uint32_t DIM_AFTER_MS = 60UL * 1000UL;
constexpr uint32_t DEBOUNCE_MS = 30;
constexpr uint32_t RETRY_MS = 2000;

constexpr size_t HISTORY_POINTS = 128; // one per display column
constexpr uint32_t HISTORY_SPAN_MS = 24UL * 60UL * 60UL * 1000UL;
constexpr uint32_t SLOT_MS = HISTORY_SPAN_MS / HISTORY_POINTS; // 675 000 ms = 11 min 15 s
static_assert(HISTORY_POINTS == static_cast<size_t>(SCREEN_W), "one history point per display column");

// A sensor inside a case reads a little warm. Compare against a thermometer you
// trust after an hour of running and put the difference here (negative lowers it).
constexpr float TEMP_OFFSET_C = 0.0f;

// The graph never zooms in further than this, so sensor noise does not look like weather.
constexpr float MIN_SPAN_TEMP_C = 2.0f;
constexpr float MIN_SPAN_PRESSURE_HPA = 4.0f;

// Addresses each part can answer on (from the part files): default first.
constexpr uint8_t OLED_ADDRESSES[] = {0x3C, 0x3D};
constexpr uint8_t BME_ADDRESSES[] = {0x76, 0x77};

enum class View : uint8_t { Now, TemperatureTrend, PressureTrend };

// Ring buffer of slot averages, oldest overwritten first.
class Trend {
 public:
  void add(float v) {
    sum_ += v;
    ++n_;
  }

  // Close the running slot and store its average.
  void closeSlot() {
    if (n_ == 0) return;
    points_[head_] = sum_ / static_cast<float>(n_);
    head_ = (head_ + 1) % HISTORY_POINTS;
    if (count_ < HISTORY_POINTS) ++count_;
    sum_ = 0;
    n_ = 0;
  }

  // Stored points plus the slot still being filled, so the graph is never stale.
  size_t size() const { return count_ + (n_ > 0 ? 1 : 0); }

  // i = 0 is the oldest point, size() - 1 the newest.
  float at(size_t i) const {
    if (i >= count_) return sum_ / static_cast<float>(n_);
    const size_t oldest = (head_ + HISTORY_POINTS - count_) % HISTORY_POINTS;
    return points_[(oldest + i) % HISTORY_POINTS];
  }

 private:
  float points_[HISTORY_POINTS] = {};
  size_t head_ = 0;
  size_t count_ = 0;
  float sum_ = 0;
  uint16_t n_ = 0;
};

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);
Adafruit_BME280 bme;

bool displayOk = false;
bool sensorOk = false;
bool haveReading = false;
bool dimmed = false;

float temperatureC = 0;
float humidityPct = 0;
float pressureHpa = 0;

Trend temperatureTrend;
Trend pressureTrend;

View view = View::Now;

uint32_t lastReadMs = 0;
uint32_t lastSlotMs = 0;
uint32_t lastPressMs = 0;
uint32_t lastRetryMs = 0;

// Debounced button state. The button pulls the pin to ground: pressed reads LOW.
bool buttonStable = HIGH;
bool buttonLastRaw = HIGH;
uint32_t buttonChangedMs = 0;

bool answers(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool startDisplay() {
  for (uint8_t address : OLED_ADDRESSES) {
    if (!answers(address)) continue;
    // periphBegin = false: Wire is already started on the pins from pins.h.
    if (!display.begin(SSD1306_SWITCHCAPVCC, address, true, false)) continue;
    display.setTextColor(SSD1306_WHITE);
    display.setTextWrap(false);
    display.clearDisplay();
    display.display();
    Serial.printf("[luft] display at 0x%02X\n", address);
    return true;
  }
  Serial.println("[luft] display not found at 0x3C or 0x3D");
  return false;
}

bool startSensor() {
  for (uint8_t address : BME_ADDRESSES) {
    if (!answers(address)) continue;
    if (!bme.begin(address, &Wire)) continue; // also fails on a BMP280 (wrong chip id)
    bme.setSampling(Adafruit_BME280::MODE_FORCED,
                    Adafruit_BME280::SAMPLING_X1,  // temperature
                    Adafruit_BME280::SAMPLING_X1,  // pressure
                    Adafruit_BME280::SAMPLING_X1,  // humidity
                    Adafruit_BME280::FILTER_OFF);
    Serial.printf("[luft] BME280 at 0x%02X\n", address);
    return true;
  }
  Serial.println("[luft] BME280 not found at 0x76 or 0x77 (a BMP280 has no humidity and is rejected)");
  return false;
}

void readSensor() {
  if (!bme.takeForcedMeasurement()) {
    sensorOk = false;
    Serial.println("[luft] sensor stopped answering");
    return;
  }
  const float t = bme.readTemperature() + TEMP_OFFSET_C;
  const float h = bme.readHumidity();
  const float p = bme.readPressure() / 100.0f; // Pa to hPa
  if (isnan(t) || isnan(h) || isnan(p)) {
    sensorOk = false;
    Serial.println("[luft] sensor returned no data");
    return;
  }
  temperatureC = t;
  humidityPct = h;
  pressureHpa = p;
  haveReading = true;
  temperatureTrend.add(t);
  pressureTrend.add(p);
  Serial.printf("[luft] %.1f C  %.0f %%  %.1f hPa\n", t, h, p);
}

int16_t textWidth(const char* text) {
  int16_t x1 = 0;
  int16_t y1 = 0;
  uint16_t w = 0;
  uint16_t h = 0;
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  return static_cast<int16_t>(w);
}

void drawMessage(const char* line1, const char* line2) {
  display.setTextSize(1);
  display.setCursor(0, 20);
  display.print(line1);
  display.setCursor(0, 34);
  display.print(line2);
}

void drawNow() {
  if (!sensorOk && !haveReading) {
    drawMessage("No air sensor found.", "Check the four wires.");
    return;
  }
  if (!haveReading) {
    drawMessage("Measuring...", "");
    return;
  }

  // Temperature, large. The degree sign is drawn as a ring: the built-in font's
  // code for it depends on a library setting, a ring does not.
  char buf[12];
  snprintf(buf, sizeof(buf), "%.1f", temperatureC);
  display.setTextSize(3);
  display.setCursor(0, 4);
  display.print(buf);
  const int16_t afterDigits = textWidth(buf) + 5;
  display.drawCircle(afterDigits, 7, 3, SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(afterDigits + 6, 4);
  display.print("C");

  // Humidity bottom left.
  snprintf(buf, sizeof(buf), "%.0f%%", humidityPct);
  display.setTextSize(2);
  display.setCursor(0, 46);
  display.print(buf);

  // Pressure bottom right: digits in the same size, unit small.
  snprintf(buf, sizeof(buf), "%.0f", pressureHpa);
  const int16_t unitWidth = 3 * 6; // "hPa" at size 1
  const int16_t digitsWidth = textWidth(buf);
  const int16_t x = SCREEN_W - unitWidth - 2 - digitsWidth;
  display.setCursor(x, 46);
  display.print(buf);
  display.setTextSize(1);
  display.setCursor(SCREEN_W - unitWidth, 53);
  display.print("hPa");

  if (!sensorOk) {
    // Last good reading is still shown; mark it stale.
    display.setCursor(SCREEN_W - 6, 0);
    display.print("!");
  }
}

void drawTrend(const Trend& trend, const char* title, const char* unit, float minSpan, uint8_t decimals) {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(title);

  const size_t n = trend.size();
  if (n < 2) {
    display.setCursor(0, 28);
    display.print("Collecting data.");
    display.setCursor(0, 40);
    display.print("First line in 11 min.");
    return;
  }

  float lo = trend.at(0);
  float hi = lo;
  for (size_t i = 1; i < n; ++i) {
    const float v = trend.at(i);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  // Range of the data, right-aligned in the title row. Title plus range must stay
  // under 21 characters (128 px at 6 px each), or the two overlap.
  char buf[24];
  snprintf(buf, sizeof(buf), "%.*f..%.*f%s", decimals, lo, decimals, hi, unit);
  display.setCursor(SCREEN_W - textWidth(buf), 0);
  display.print(buf);

  // Pad a flat line out to the minimum span, centred.
  if (hi - lo < minSpan) {
    const float mid = (hi + lo) / 2.0f;
    lo = mid - minSpan / 2.0f;
    hi = mid + minSpan / 2.0f;
  }

  constexpr int16_t top = 12;
  constexpr int16_t bottom = SCREEN_H - 1;
  const float scale = static_cast<float>(bottom - top) / (hi - lo);

  // Newest point at the right edge, one column per point.
  const int16_t firstX = SCREEN_W - static_cast<int16_t>(n);
  int16_t prevY = 0;
  for (size_t i = 0; i < n; ++i) {
    const int16_t x = firstX + static_cast<int16_t>(i);
    const int16_t y = bottom - static_cast<int16_t>(lroundf((trend.at(i) - lo) * scale));
    if (i == 0) {
      display.drawPixel(x, y, SSD1306_WHITE);
    } else {
      display.drawLine(x - 1, prevY, x, y, SSD1306_WHITE);
    }
    prevY = y;
  }
}

void render() {
  if (!displayOk) return;
  display.clearDisplay();
  switch (view) {
    case View::Now:
      drawNow();
      break;
    case View::TemperatureTrend:
      drawTrend(temperatureTrend, "Temp 24h", " C", MIN_SPAN_TEMP_C, 1);
      break;
    case View::PressureTrend:
      drawTrend(pressureTrend, "hPa 24h", "", MIN_SPAN_PRESSURE_HPA, 0);
      break;
  }
  display.display();
}

void setDimmed(bool on) {
  if (!displayOk || dimmed == on) return;
  dimmed = on;
  display.dim(on);
}

void nextView() {
  switch (view) {
    case View::Now:
      view = View::TemperatureTrend;
      break;
    case View::TemperatureTrend:
      view = View::PressureTrend;
      break;
    case View::PressureTrend:
      view = View::Now;
      break;
  }
}

// True once per press, after the contact has been steady for DEBOUNCE_MS.
bool buttonPressed(uint32_t now) {
  const bool raw = digitalRead(PIN_BUTTON);
  if (raw != buttonLastRaw) {
    buttonLastRaw = raw;
    buttonChangedMs = now;
  }
  if (now - buttonChangedMs < DEBOUNCE_MS || raw == buttonStable) return false;
  buttonStable = raw;
  return buttonStable == LOW;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  displayOk = startDisplay();
  sensorOk = startSensor();

  const uint32_t now = millis();
  lastSlotMs = now;
  lastPressMs = now;
  lastRetryMs = now;
  if (sensorOk) readSensor();
  lastReadMs = now;
  render();
}

void loop() {
  const uint32_t now = millis();
  bool redraw = false;

  if (buttonPressed(now)) {
    lastPressMs = now;
    if (dimmed) {
      setDimmed(false); // first press only wakes the display
    } else {
      nextView();
      redraw = true;
    }
  }

  if (!dimmed && now - lastPressMs >= DIM_AFTER_MS) setDimmed(true);

  // A part that was missing at power-up, or dropped off the bus, is looked for again.
  if ((!displayOk || !sensorOk) && now - lastRetryMs >= RETRY_MS) {
    lastRetryMs = now;
    if (!displayOk) {
      displayOk = startDisplay();
      if (displayOk) dimmed = false; // a fresh display starts at full brightness
    }
    if (!sensorOk) sensorOk = startSensor();
    redraw = true;
  }

  if (sensorOk && now - lastReadMs >= READ_INTERVAL_MS) {
    lastReadMs = now;
    readSensor();
    redraw = true;
  }

  if (now - lastSlotMs >= SLOT_MS) {
    lastSlotMs += SLOT_MS;
    temperatureTrend.closeSlot();
    pressureTrend.closeSlot();
    redraw = true;
  }

  if (redraw) render();
  delay(5);
}
