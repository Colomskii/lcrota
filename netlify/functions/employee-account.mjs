import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// -----------------------------------------------------------------------------
// Firebase Admin initialisation
// -----------------------------------------------------------------------------

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!rawServiceAccount) {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT_JSON is not available to the Netlify function."
  );
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert(JSON.parse(rawServiceAccount)),
  });
}

const auth = getAuth();
const db = getFirestore();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function validRole(role) {
  return role === "staff" || role === "senior";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function getAuthenticatedCaller(request) {
  const authorization = request.headers.get("authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    const error = new Error("Missing authentication token.");
    error.statusCode = 401;
    throw error;
  }

  const token = authorization.slice(7);

  return auth.verifyIdToken(token);
}

// -----------------------------------------------------------------------------
// Verify that the caller is the Longcroft administrator
// -----------------------------------------------------------------------------

async function requireAdmin(request) {
  const decoded = await getAuthenticatedCaller(request);

  // Preserve access for the original shared administrator account.
  const legacyAdmin = decoded.email === "editor@longcroft.local";

  if (legacyAdmin) {
    return decoded;
  }

  const callerSnapshot = await db
    .collection("users")
    .doc(decoded.uid)
    .get();

  const callerProfile = callerSnapshot.exists
    ? callerSnapshot.data()
    : null;

  if (!callerProfile || callerProfile.role !== "admin") {
    const error = new Error("Administrator access is required.");
    error.statusCode = 403;
    throw error;
  }

  return decoded;
}

// -----------------------------------------------------------------------------
// Mark an individual user's temporary-password requirement as complete.
//
// This is intentionally handled server-side because normal Staff/Senior
// accounts must not be granted direct write access to the private /employees
// collection merely to update the Employee Register status badge.
// -----------------------------------------------------------------------------

async function completeOwnPasswordChange(request) {
  const decoded = await getAuthenticatedCaller(request);

  // The legacy shared accounts do not participate in the individual employee
  // account/password-change system.
  if (
    decoded.email === "editor@longcroft.local" ||
    decoded.email === "viewer@longcroft.local"
  ) {
    const error = new Error(
      "Password-change completion is only available for individual accounts."
    );
    error.statusCode = 403;
    throw error;
  }

  const userRef = db
    .collection("users")
    .doc(decoded.uid);

  const userSnapshot = await userRef.get();

  if (!userSnapshot.exists) {
    const error = new Error("User profile not found.");
    error.statusCode = 404;
    throw error;
  }

  const userProfile = userSnapshot.data();

  if (!userProfile.employeeId) {
    const error = new Error(
      "This account is not linked to an employee."
    );
    error.statusCode = 400;
    throw error;
  }

  if (userProfile.accountEnabled === false) {
    const error = new Error("This account is disabled.");
    error.statusCode = 403;
    throw error;
  }

  const employeeRef = db
    .collection("employees")
    .doc(userProfile.employeeId);

  const employeeSnapshot = await employeeRef.get();

  if (!employeeSnapshot.exists) {
    const error = new Error(
      "Linked employee record not found."
    );
    error.statusCode = 404;
    throw error;
  }

  const employee = employeeSnapshot.data();

  // Defensive check: if the employee record has an authUid, it must belong
  // to the currently authenticated user.
  if (
    employee.authUid &&
    employee.authUid !== decoded.uid
  ) {
    const error = new Error(
      "The linked employee account does not match the authenticated user."
    );
    error.statusCode = 403;
    throw error;
  }

  const now = new Date().toISOString();

  const batch = db.batch();

  batch.set(
    userRef,
    {
      mustChangePassword: false,
      passwordChangedAt: now,
      updatedAt: now,
    },
    {
      merge: true,
    }
  );

  batch.set(
    employeeRef,
    {
      mustChangePassword: false,
      passwordChangedAt: now,
      accountUpdatedAt: now,
    },
    {
      merge: true,
    }
  );

  await batch.commit();

  return {
    ok: true,
    action: "completePasswordChange",
    mustChangePassword: false,
  };
}

// -----------------------------------------------------------------------------
// Netlify Function
// -----------------------------------------------------------------------------

export default async (request) => {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        error: "POST required.",
      },
      405
    );
  }

  try {
    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        {
          error: "Invalid JSON request body.",
        },
        400
      );
    }

    const { action } = body;

    // =========================================================================
    // COMPLETE OWN PASSWORD CHANGE
    //
    // This action is intentionally available to the authenticated individual
    // user. It does NOT provide general Employee Register access.
    // =========================================================================

    if (action === "completePasswordChange") {
      const result =
        await completeOwnPasswordChange(request);

      return jsonResponse(result);
    }

    // Every remaining action is an administrator operation.
    const caller = await requireAdmin(request);

    const { employeeId } = body;

    if (!employeeId) {
      return jsonResponse(
        {
          error: "Employee ID is required.",
        },
        400
      );
    }

    const employeeRef = db
      .collection("employees")
      .doc(employeeId);

    const employeeSnapshot = await employeeRef.get();

    if (!employeeSnapshot.exists) {
      return jsonResponse(
        {
          error: "Employee not found.",
        },
        404
      );
    }

    const employee = employeeSnapshot.data();

    const now = new Date().toISOString();

    // =========================================================================
    // CREATE ACCOUNT
    // =========================================================================

    if (action === "create") {
      const username = cleanUsername(body.username);
      const role = body.role;
      const temporaryPassword = String(
        body.temporaryPassword || ""
      );

      if (username.length < 3) {
        return jsonResponse(
          {
            error: "Username must be at least 3 characters.",
          },
          400
        );
      }

      if (!validRole(role)) {
        return jsonResponse(
          {
            error: "Role must be either staff or senior.",
          },
          400
        );
      }

      if (temporaryPassword.length < 8) {
        return jsonResponse(
          {
            error:
              "Temporary password must be at least 8 characters.",
          },
          400
        );
      }

      if (employee.authUid) {
        return jsonResponse(
          {
            error:
              "This employee already has a login account.",
          },
          409
        );
      }

      const usernameRef = db
        .collection("usernames")
        .doc(username);

      const existingUsername = await usernameRef.get();

      if (existingUsername.exists) {
        return jsonResponse(
          {
            error: "That username is already in use.",
          },
          409
        );
      }

      const email = `${username}@longcroft.internal`;

      let createdUser;

      try {
        createdUser = await auth.createUser({
          email,
          password: temporaryPassword,
          displayName:
            employee.displayName || username,
          disabled: false,
        });
      } catch (error) {
        console.error(
          "Firebase Auth createUser failed:",
          error
        );

        if (
          error.code === "auth/email-already-exists"
        ) {
          return jsonResponse(
            {
              error: "That username is already in use.",
            },
            409
          );
        }

        throw error;
      }

      try {
        await db.runTransaction(
          async (transaction) => {
            const transactionUsernameSnapshot =
              await transaction.get(usernameRef);

            if (
              transactionUsernameSnapshot.exists
            ) {
              throw new Error(
                "That username is already in use."
              );
            }

            const userRef = db
              .collection("users")
              .doc(createdUser.uid);

            transaction.set(usernameRef, {
              uid: createdUser.uid,
              employeeId,
              createdAt: now,
            });

            transaction.set(userRef, {
              employeeId,
              username,
              displayName:
                employee.displayName || "",
              role,
              accountEnabled: true,
              mustChangePassword: true,
              createdAt: now,
              createdBy:
                caller.email || caller.uid,
              updatedAt: now,
            });

            transaction.set(
              employeeRef,
              {
                authUid: createdUser.uid,
                username,
                accountRole: role,
                accountEnabled: true,
                mustChangePassword: true,
                accountUpdatedAt: now,
              },
              {
                merge: true,
              }
            );
          }
        );
      } catch (error) {
        try {
          await auth.deleteUser(
            createdUser.uid
          );
        } catch (rollbackError) {
          console.error(
            "Failed to roll back Firebase Auth user:",
            rollbackError
          );
        }

        throw error;
      }

      return jsonResponse({
        ok: true,
        action: "create",
        uid: createdUser.uid,
        username,
        role,
        accountEnabled: true,
        mustChangePassword: true,
      });
    }

    // Every action below here requires an existing linked account.

    if (!employee.authUid) {
      return jsonResponse(
        {
          error:
            "This employee does not have a login account.",
        },
        400
      );
    }

    // =========================================================================
    // RESET PASSWORD
    // =========================================================================

    if (action === "resetPassword") {
      const temporaryPassword = String(
        body.temporaryPassword || ""
      );

      if (temporaryPassword.length < 8) {
        return jsonResponse(
          {
            error:
              "Temporary password must be at least 8 characters.",
          },
          400
        );
      }

      await auth.updateUser(
        employee.authUid,
        {
          password: temporaryPassword,
        }
      );

      const userRef = db
        .collection("users")
        .doc(employee.authUid);

      await Promise.all([
        userRef.set(
          {
            mustChangePassword: true,
            passwordResetAt: now,
            updatedAt: now,
            updatedBy:
              caller.email || caller.uid,
          },
          {
            merge: true,
          }
        ),

        employeeRef.set(
          {
            mustChangePassword: true,
            accountUpdatedAt: now,
          },
          {
            merge: true,
          }
        ),
      ]);

      return jsonResponse({
        ok: true,
        action: "resetPassword",
        mustChangePassword: true,
      });
    }

    // =========================================================================
    // UPDATE ACCESS
    // =========================================================================

    if (action === "updateAccess") {
      const role = body.role;

      const accountEnabled =
        body.accountEnabled !== false;

      if (!validRole(role)) {
        return jsonResponse(
          {
            error:
              "Role must be either staff or senior.",
          },
          400
        );
      }

      await auth.updateUser(
        employee.authUid,
        {
          disabled: !accountEnabled,
        }
      );

      const userRef = db
        .collection("users")
        .doc(employee.authUid);

      await Promise.all([
        userRef.set(
          {
            role,
            accountEnabled,
            updatedAt: now,
            updatedBy:
              caller.email || caller.uid,
          },
          {
            merge: true,
          }
        ),

        employeeRef.set(
          {
            accountRole: role,
            accountEnabled,
            accountUpdatedAt: now,
          },
          {
            merge: true,
          }
        ),
      ]);

      return jsonResponse({
        ok: true,
        action: "updateAccess",
        role,
        accountEnabled,
      });
    }

    // =========================================================================
    // UNKNOWN ACTION
    // =========================================================================

    return jsonResponse(
      {
        error: "Unknown account action.",
      },
      400
    );
  } catch (error) {
    console.error(
      "employee-account function error:",
      error
    );

    return jsonResponse(
      {
        error:
          error?.message ||
          "Account operation failed.",
      },
      error?.statusCode || 500
    );
  }
};