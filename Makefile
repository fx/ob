# Makefile for ob — task runner. CI workflow files are intentionally
# out-of-scope per change 0006; CI invokes the same targets so dev and CI
# share one command surface.
#
# `build` is the default. It runs the same gates CI enforces: lint
# (Biome + hadolint), typecheck, and the coverage-gated test suite.

.PHONY: build test image image-push lint typecheck

# Override via `make image IMAGE=ghcr.io/<org>/ob:<tag>` etc.
IMAGE ?= ob:dev

build: lint typecheck test

lint:
	bun run lint

typecheck:
	bun run typecheck

test:
	bun run test:cov

# Build the production image. Docker requires sudo on the dev container
# host; if your environment grants the user docker-group membership, set
# `SUDO=` to disable the prefix (e.g. `make image SUDO=`).
SUDO ?= sudo
image:
	$(SUDO) docker build -t $(IMAGE) .

# Push to a registry. Caller must supply IMAGE as the fully-qualified ref:
#   make image-push IMAGE=ghcr.io/<org>/ob:<tag>
image-push:
	$(SUDO) docker push $(IMAGE)
