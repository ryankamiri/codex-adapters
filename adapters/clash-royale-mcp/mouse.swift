#!/usr/bin/env swift

import CoreGraphics
import Foundation

func usage() -> Never {
  fputs("usage: mouse.swift tap x y | swipe x1 y1 x2 y2 durationMs steps\n", stderr)
  exit(2)
}

func number(_ index: Int) -> Double {
  guard CommandLine.arguments.indices.contains(index),
        let value = Double(CommandLine.arguments[index]) else {
    usage()
  }
  return value
}

func post(_ type: CGEventType, _ x: Double, _ y: Double) {
  let point = CGPoint(x: x, y: y)
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
    fputs("failed to create mouse event\n", stderr)
    exit(1)
  }
  event.post(tap: .cghidEventTap)
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

switch mode {
case "tap":
  let x = number(2)
  let y = number(3)
  post(.mouseMoved, x, y)
  usleep(30_000)
  post(.leftMouseDown, x, y)
  usleep(60_000)
  post(.leftMouseUp, x, y)

case "swipe":
  let x1 = number(2)
  let y1 = number(3)
  let x2 = number(4)
  let y2 = number(5)
  let durationMs = max(1.0, number(6))
  let steps = max(2, Int(number(7)))
  let sleepUs = useconds_t((durationMs * 1000.0) / Double(steps))

  post(.mouseMoved, x1, y1)
  usleep(30_000)
  post(.leftMouseDown, x1, y1)
  for step in 1...steps {
    let t = Double(step) / Double(steps)
    let x = x1 + (x2 - x1) * t
    let y = y1 + (y2 - y1) * t
    post(.leftMouseDragged, x, y)
    usleep(sleepUs)
  }
  post(.leftMouseUp, x2, y2)

default:
  usage()
}
