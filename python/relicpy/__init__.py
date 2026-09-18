"""relicpy — relic's index, read through Pydantic models.

An explicit package rather than an implicit namespace one: namespace packages resolve
by scanning sys.path, so a stray `relicpy/` directory anywhere ahead of this one would
be imported instead, silently.
"""

__version__ = "26.9.18"
