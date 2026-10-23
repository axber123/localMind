import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from embedding_worker import mean_pool, normalize  # noqa: E402


def test_mean_pool_ignores_padding() -> None:
    hidden = np.array(
        [
            [[1.0, 2.0], [3.0, 4.0], [100.0, 100.0]],
            [[2.0, 4.0], [6.0, 8.0], [10.0, 12.0]],
        ],
        dtype=np.float32,
    )
    mask = np.array([[1, 1, 0], [1, 1, 1]], dtype=np.int64)
    pooled = mean_pool(hidden, mask)
    np.testing.assert_allclose(pooled[0], [2.0, 3.0])
    np.testing.assert_allclose(pooled[1], [6.0, 8.0])


def test_normalize_returns_unit_vectors() -> None:
    vectors = normalize(np.array([[3.0, 4.0], [0.0, -2.0]], dtype=np.float32))
    np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), [1.0, 1.0], rtol=1e-6)
    np.testing.assert_allclose(vectors[0], [0.6, 0.8], rtol=1e-6)


def test_normalize_zero_vector_is_finite() -> None:
    vectors = normalize(np.zeros((1, 4), dtype=np.float32))
    assert np.isfinite(vectors).all()
