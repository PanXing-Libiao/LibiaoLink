"""Explicit OCCT name codepages; raw legacy bytes cannot identify a charset.

OCCT V7_8_1 STEPControl_Controller.cxx registers read.step.codepage with UTF8
as the default and GB as the legacy Chinese option. Never guess GB from invalid
UTF-8: the same bytes can be valid in several legacy encodings.
"""

def name_codepage(value='UTF8'):
    if value not in ('UTF8','GB'):
        raise ValueError('unsupported-step-name-codepage: expected UTF8 or GB')
    return value
