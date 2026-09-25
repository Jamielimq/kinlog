use anchor_lang::prelude::*;

#[error_code]
pub enum LockedInError {
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Invalid limit value")]
    InvalidLimit,
    #[msg("Unknown cohort kind")]
    InvalidKind,
    #[msg("Day length is below the configured minimum or above one day")]
    InvalidDayLength,
    #[msg("Real cohorts must start at 15:00 UTC")]
    MisalignedStart,
    #[msg("Cohort must start in the future")]
    StartInPast,
    #[msg("Cohort must end within 30 days of creation")]
    EndTooFar,
    #[msg("Deposit amount is zero or above the configured maximum")]
    InvalidDepositAmount,
    #[msg("Reward amount is zero or not a multiple of 0.00001 ORE")]
    InvalidRewardAmount,
    #[msg("Legendary reward exceeds max_reward_per_box")]
    RewardAboveMax,
    #[msg("Too many live cohorts of this kind")]
    TooManyLiveCohorts,
    #[msg("Reward vault has too little unreserved ORE")]
    InsufficientRewardVault,
    #[msg("New deposits are paused")]
    DepositsPaused,
    #[msg("Joining is only open before the start and during the first day")]
    JoiningClosed,
    #[msg("Cohort is full")]
    CohortFull,
    #[msg("Wallet already joined this cohort")]
    AlreadyJoined,
    #[msg("Wallet is not in this cohort")]
    NotParticipant,
    #[msg("Cohort has not ended yet")]
    CohortNotEnded,
    #[msg("Deposit already returned")]
    AlreadyReturned,
    #[msg("Success can only be marked from the last day until the claim deadline")]
    SuccessWindowClosed,
    #[msg("Participant has not completed the challenge")]
    NotSuccessful,
    #[msg("Square already picked")]
    AlreadyPicked,
    #[msg("Square must be 0-24")]
    InvalidSquare,
    #[msg("Claim deadline has passed")]
    DeadlinePassed,
    #[msg("No square picked")]
    NotPicked,
    #[msg("Already settled")]
    AlreadySettled,
    #[msg("Picks settle strictly in the order they were recorded")]
    OutOfOrder,
    #[msg("Account is not the ORE board")]
    InvalidBoard,
    #[msg("Account is not the expected ORE round")]
    InvalidRound,
    #[msg("ORE round result is not available yet")]
    RoundNotRevealed,
    #[msg("Retarget is only for a finished round without entropy")]
    RetargetNotAllowed,
    #[msg("Target round finished without entropy; retarget it")]
    RoundNeedsRetarget,
    #[msg("Not settled yet")]
    NotSettled,
    #[msg("Reward already claimed")]
    AlreadyClaimed,
    #[msg("Claim deadline has not passed yet")]
    DeadlineNotPassed,
    #[msg("Deposits still outstanding")]
    DepositsOutstanding,
    #[msg("Arithmetic overflow")]
    Overflow,
}
