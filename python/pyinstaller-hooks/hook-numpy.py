# PyInstaller's bundled NumPy hook crashes on this machine because it misidentifies
# the Anaconda-packaged NumPy and imports a helper that is not present in this
# PyInstaller release. This hook keeps the standard collection steps but omits the
# broken conda-specific branch. Priority 2 overrides the bundled hook.
# $PyInstaller-Hook-Priority: 2
from importlib.metadata import version
from packaging.version import Version
from PyInstaller import compat
from PyInstaller.utils.hooks import collect_dynamic_libs

numpy_version = Version(version("numpy")).release
binaries = collect_dynamic_libs("numpy")
datas = []
hiddenimports = []

if numpy_version >= (2, 0):
    hiddenimports += ["numpy._core._dtype_ctypes", "numpy._core._multiarray_tests"]
else:
    hiddenimports += ["numpy.core._dtype_ctypes"]
    if numpy_version >= (1, 25):
        hiddenimports += ["numpy.core._multiarray_tests"]

excludedimports = ["scipy", "pytest", "nose", "f2py", "setuptools"]
if numpy_version < (1, 22, 0) or numpy_version > (1, 22, 1):
    excludedimports += ["distutils", "numpy.distutils"]
if numpy_version < (2, 0):
    excludedimports += ["numpy.f2py"]
