/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2013, Joshua M. Clulow
 */

/*
 * Box/line-drawing characters for different terminal modes:
 */

const ESC = "\u001b";
const utf8 = {
  on: "",
  off: "",
  horiz: "\u2501",
  verti: "\u2503",
  topleft: "\u250f",
  topright: "\u2513",
  bottomright: "\u251b",
  bottomleft: "\u2517"
};
const vt100 = {
  on: ESC + "(0",
  off: ESC + "(B",
  horiz: "\u0071",
  verti: "\u0078",
  topleft: "\u006c",
  topright: "\u006b",
  bottomright: "\u006a",
  bottomleft: "\u006d"
};
const ascii = {
  on: "",
  off: "",
  horiz: "-",
  verti: "|",
  topleft: "+",
  topright: "+",
  bottomright: "+",
  bottomleft: "+"
};

export { ascii, utf8, vt100 };

/* vim: set ts=8 sts=8 sw=8 noet: */
