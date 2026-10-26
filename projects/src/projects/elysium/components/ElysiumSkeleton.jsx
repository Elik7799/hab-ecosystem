export function MovieCardSkeleton() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-poster" />
      <div className="skeleton-info">
        <div className="skeleton-line skeleton-line-long" />
        <div className="skeleton-line skeleton-line-short" />
      </div>
    </div>
  )
}

export function MovieGridSkeleton({ count = 20 }) {
  return (
    <div className="main-moviesgrid">
      {Array.from({ length: count }).map((_, i) => (
        <MovieCardSkeleton key={i} />
      ))}
    </div>
  )
}

export function MovieDetailSkeleton() {
  return (
    <div className="moviedetail">
      <div className="moviedetail-top">
        <div className="skeleton-detail-poster" />
        <div className="moviedetail-info">
          <div className="skeleton-line skeleton-line-title" />
          <div className="skeleton-line skeleton-line-medium" />
          <div className="skeleton-line skeleton-line-short" />
          <div className="skeleton-line skeleton-line-long" />
          <div className="skeleton-line skeleton-line-long" />
          <div className="skeleton-line skeleton-line-medium" />
        </div>
      </div>
    </div>
  )
}

export function ProfileSkeleton() {
  return (
    <div className="profile-body">
      <div className="profile-header">
        <div className="skeleton-avatar" />
        <div className="profile-info">
          <div className="skeleton-line skeleton-line-medium" />
          <div className="skeleton-line skeleton-line-short" />
        </div>
      </div>
      <div className="profile-stats">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="profile-stat">
            <div className="skeleton-line skeleton-line-short" />
            <div className="skeleton-line skeleton-line-medium" />
          </div>
        ))}
      </div>
      <MovieGridSkeleton count={6} />
    </div>
  )
}