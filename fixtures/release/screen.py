"""Render a captured terminal byte stream to the text actually on screen (needs `pyte`)."""
import pyte


def screen_text(raw, columns=130, rows=38):
    screen = pyte.Screen(columns, rows)
    pyte.ByteStream(screen).feed(bytes(raw))
    return "\n".join(line.rstrip() for line in screen.display)
